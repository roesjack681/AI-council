import type { CouncilDB } from '../database/db';
import type { ComplianceGate } from '../adapters/base/compliance-gate';
import {
  BRAIN_DISCUSSION_ID,
  type BrainRequest,
  type BrainRoute,
  type QueueTask,
  type VerificationPolicy,
} from '../protocols/domain';
import { parseBrainRoute, repairBrainPrompt } from '../core/brain-router';
import { CouncilError, errorText, requireValue } from '../utils/errors';
import { newId } from '../utils/id';
import { log } from '../utils/logger';
import { RequestCoordinator } from '../core/request-coordinator';
import { isPagePreparationPending, PAGE_STARTUP_TIMEOUT_MS } from '../core/page-readiness';

type ActivePhase = NonNullable<BrainRequest['resumePhase']>;
const active = (phase: BrainRequest['phase']): phase is ActivePhase =>
  ['pending', 'sending', 'waiting', 'routing'].includes(phase);
const taskFor = (participantId: string, discussionId?: string): QueueTask => {
  const now = Date.now(),
    id = newId();
  return {
    id,
    dedupeKey: `brain:${id}`,
    discussionId: discussionId ?? `${BRAIN_DISCUSSION_ID}:${id}`,
    participantId,
    messageId: newId(),
    roundId: 'brain-round',
    taskType: 'initial',
    status: 'pending',
    retryCount: 0,
    nextRetryAt: now,
    leaseUntil: 0,
    createdAt: now,
    updatedAt: now,
  };
};
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CouncilError('OPERATION_TIMEOUT', '路由操作超时；保留原请求以核对发送')),
          8000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One persisted routing step per tick. Never waits for a complete model response inside a command. */
export class BrainRequestRunner {
  private readonly owner = newId();
  constructor(
    private readonly db: CouncilDB,
    private readonly gate: ComplianceGate,
    private readonly apply: (
      request: BrainRequest,
      route: BrainRoute,
    ) => Promise<{ discussionId?: string; noticeIds: string[] }>,
  ) {}

  async enqueue(
    participantId: string,
    question: string,
    prompt: string,
    verificationPolicy: VerificationPolicy,
    userRequestId?: string,
  ): Promise<BrainRequest> {
    return this.db.transaction('rw', [this.db.brain_requests, this.db.logs], async () => {
      if ((await this.db.brain_requests.toArray()).some((job) => active(job.phase)))
        throw new CouncilError('BRAIN_BUSY', '大脑已有待处理请求，请等待完成或暂停后重试');
      const now = Date.now();
      const request: BrainRequest = {
        id: newId(),
        participantId,
        question,
        prompt,
        verificationPolicy,
        userRequestId,
        task: taskFor(participantId),
        phase: 'pending',
        noticeIds: [],
        repairCount: 0,
        retryCount: 0,
        confirmationAttempts: 0,
        nextRetryAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.brain_requests.add(request);
      await log(this.db, 'info', 'BRAIN_REQUEST_QUEUED', request.id);
      return request;
    });
  }
  async resume(id: string): Promise<void> {
    const job = requireValue(await this.db.brain_requests.get(id), '路由请求不存在');
    if (job.phase !== 'paused') throw new CouncilError('NOT_PAUSED', '路由请求未暂停');
    if ((await this.db.brain_requests.toArray()).some((other) => active(other.phase)))
      throw new CouncilError('BRAIN_BUSY', '请先完成或暂停当前路由请求');
    await this.update(job, {
      phase: job.resumePhase ?? 'pending',
      error: undefined,
      confirmationAttempts: 0,
      retryCount: 0,
      nextRetryAt: Date.now(),
      deadline: Date.now() + 120_000,
    });
  }
  async cancel(id: string): Promise<void> {
    const job = requireValue(await this.db.brain_requests.get(id), '路由请求不存在');
    if (job.phase === 'done' || job.phase === 'cancelled') return;
    await this.update(job, { phase: 'cancelled' });
    await log(this.db, 'info', 'BRAIN_REQUEST_CANCELLED', id);
  }
  private async update(job: BrainRequest, patch: Partial<BrainRequest>): Promise<void> {
    await this.db.transaction('rw', this.db.brain_requests, async () => {
      const stored = requireValue(await this.db.brain_requests.get(job.id), '路由请求不存在');
      Object.assign(job, stored, patch, { updatedAt: Date.now() });
      await this.db.brain_requests.put(job);
    });
  }
  private async pause(
    job: BrainRequest,
    phase: ActivePhase,
    code: string,
    detail: string,
  ): Promise<void> {
    await this.update(job, { phase: 'paused', resumePhase: phase, error: { code, detail } });
    await log(this.db, 'warn', code, job.id);
  }
  private async acceptReply(job: BrainRequest, raw: string): Promise<void> {
    if (!raw.trim() || raw.length > 200_000)
      throw new CouncilError('INVALID_RESPONSE', '路由回复为空或过大');
    await this.update(job, { phase: 'routing', raw, nextRetryAt: Date.now() });
  }
  async step(): Promise<void> {
    const acquired = await this.db.transaction('rw', this.db.leases, async () => {
      const lease = await this.db.leases.get('brain-runner');
      if (lease && lease.until > Date.now()) return false;
      await this.db.leases.put({
        id: 'brain-runner',
        owner: this.owner,
        until: Date.now() + 45_000,
      });
      return true;
    });
    if (!acquired) return;
    try {
      const job = (await this.db.brain_requests.orderBy('createdAt').toArray()).find(
        (row) => active(row.phase) && row.nextRetryAt <= Date.now(),
      );
      if (!job || !active(job.phase)) return;
      const phase = job.phase;
      try {
        if (!(await new RequestCoordinator(this.db).isCurrent(job.userRequestId))) {
          await this.pause(job, phase, 'REQUEST_SUPERSEDED', '旧路由不是本次问题，已暂停');
          return;
        }
        if (phase === 'waiting' && job.receipt) {
          const cached = await this.gate.cachedResponse({
            ...job.task,
            status: 'waiting',
            receiptId: job.receipt.id,
            startedAt: job.receipt.submittedAt,
          });
          if (cached) {
            await this.acceptReply(job, cached.raw);
            return;
          }
        }
        if (phase === 'routing') {
          let route: BrainRoute;
          try {
            route = job.route ?? parseBrainRoute(job.raw ?? '');
          } catch (error) {
            if (job.repairCount >= 1) throw error;
            await this.update(job, {
              phase: 'pending',
              task: taskFor(job.participantId, job.task.discussionId),
              prompt: repairBrainPrompt(job.prompt, job.raw ?? ''),
              receipt: undefined,
              raw: undefined,
              repairCount: job.repairCount + 1,
              retryCount: 0,
              confirmationAttempts: 0,
              nextRetryAt: Date.now(),
            });
            await log(this.db, 'warn', 'BRAIN_PROTOCOL_REPAIR', job.id);
            return;
          }
          await this.update(job, { route });
          const outcome = await this.apply(job, route);
          await this.update(job, { ...outcome, phase: 'done', error: undefined });
          await log(this.db, 'info', 'BRAIN_ROUTE_APPLIED', job.id);
          return;
        }
        const adapter = await bounded(
          this.gate.requireReady(
            job.participantId,
            phase === 'pending' ? 'initial' : 'observe',
            job.task.discussionId,
          ),
        );
        if (phase === 'pending') {
          await this.update(job, { phase: 'sending' }); // Durable before any possible dispatch.
          try {
            const receipt = await bounded(adapter.submit(job.task, job.prompt, job.task.dedupeKey));
            await this.update(job, {
              phase: 'waiting',
              receipt,
              deadline: Date.now() + 120_000,
              nextRetryAt: Date.now() + 1000,
              error: undefined,
            });
          } catch (error) {
            if (error instanceof CouncilError && error.safeToRetry) {
              if (error.code === 'SESSION_INITIALIZING') {
                await this.update(job, { phase: 'pending', nextRetryAt: Date.now() + 1000 });
              } else if (error.retryable && job.retryCount < 2) {
                await this.update(job, {
                  phase: 'pending',
                  retryCount: job.retryCount + 1,
                  nextRetryAt: Date.now() + 2000,
                });
              } else await this.pause(job, 'pending', error.code, error.message);
            } else await this.update(job, { phase: 'sending', nextRetryAt: Date.now() + 2000 });
          }
          return;
        }
        if (phase === 'sending') {
          const result = await bounded(adapter.reconcile(job.task, job.task.dedupeKey));
          if (result.state === 'submitted')
            await this.update(job, {
              phase: 'waiting',
              receipt: result.receipt,
              deadline: Date.now() + 120_000,
              nextRetryAt: Date.now(),
              error: undefined,
            });
          else if (result.state === 'not_sent')
            await this.update(job, { phase: 'pending', nextRetryAt: Date.now() });
          else {
            const attempts = job.confirmationAttempts + 1;
            await this.update(job, {
              confirmationAttempts: attempts,
              nextRetryAt: Date.now() + 2000,
            });
            if (attempts >= 5)
              await this.pause(
                job,
                'sending',
                'DELIVERY_UNKNOWN',
                '发送结果仍未知，未重复提交；请保留大脑讨论页后恢复核对',
              );
          }
          return;
        }
        const result = await bounded(
          adapter.poll(job.task, requireValue(job.receipt, '缺少大脑发送凭据')),
        );
        if (result.state === 'complete') {
          await this.acceptReply(job, result.raw);
        } else if (result.state !== 'pending')
          throw new CouncilError('BRAIN_PAGE_UNAVAILABLE', result.reason || '大脑页面需要处理');
        else if (Date.now() >= (job.deadline ?? 0))
          await this.pause(
            job,
            'waiting',
            'BRAIN_TIMEOUT',
            '等待路由回复超时；保留原凭据，可恢复读取',
          );
        else await this.update(job, { nextRetryAt: Date.now() + 1500 });
      } catch (error) {
        const code = error instanceof CouncilError ? error.code : 'BRAIN_STEP_FAILED';
        if (phase === 'pending' && isPagePreparationPending(code)) {
          const deadline = job.task.preflightDeadline ?? Date.now() + PAGE_STARTUP_TIMEOUT_MS;
          if (Date.now() < deadline) {
            await this.update(job, {
              task: { ...job.task, preflightDeadline: deadline },
              nextRetryAt: Date.now() + 1000,
            });
            await log(this.db, 'info', 'BRAIN_PAGE_PREPARATION_WAIT', code);
            return;
          }
        }
        await this.pause(
          job,
          phase,
          error instanceof CouncilError ? error.code : 'BRAIN_STEP_FAILED',
          errorText(error),
        );
      }
    } finally {
      await this.db.transaction('rw', this.db.leases, async () => {
        if ((await this.db.leases.get('brain-runner'))?.owner === this.owner)
          await this.db.leases.delete('brain-runner');
      });
    }
  }
}
