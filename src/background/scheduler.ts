import type { CouncilDB } from '../database/db';
import type { QueueTask } from '../protocols/domain';
import type { CompletedResponse } from '../adapters/base/adapter.interface';
import { ComplianceGate } from '../adapters/base/compliance-gate';
import { DiscussionEngine } from '../core/discussion-engine';
import { TaskManager, terminal } from '../core/task-manager';
import { MessageManager } from '../core/message-manager';
import { ResponseProcessor } from '../core/response-processor';
import { ReportGenerator } from '../reports/report-generator';
import { CouncilError, requireValue, errorText } from '../utils/errors';
import { newId } from '../utils/id';
import { log } from '../utils/logger';
import { RequestCoordinator } from '../core/request-coordinator';
import { isPagePreparationPending, PAGE_STARTUP_TIMEOUT_MS } from '../core/page-readiness';

async function bounded<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CouncilError('OPERATION_TIMEOUT', '交互操作超时，发送结果可能未知')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export class Scheduler {
  private readonly owner = newId();
  private busy = false;
  constructor(
    private readonly db: CouncilDB,
    private readonly gate: ComplianceGate,
    private readonly engine: DiscussionEngine,
  ) {}
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let acquired = false;
    try {
      acquired = await this.db.transaction('rw', this.db.leases, async () => {
        const lease = await this.db.leases.get('scheduler');
        if (lease && lease.until > Date.now()) return false;
        await this.db.leases.put({
          id: 'scheduler',
          owner: this.owner,
          until: Date.now() + 45_000,
        });
        return true;
      });
      if (!acquired) return;
      const discussions = await this.db.discussions.toArray();
      for (const d of discussions) {
        if (
          !terminal(d.status) &&
          !['PAUSED', 'CREATED'].includes(d.status) &&
          !(await new RequestCoordinator(this.db).isCurrent(d.userRequestId))
        ) {
          await new TaskManager(this.db).pause(
            d.id,
            'REQUEST_SUPERSEDED',
            '此题不是当前用户请求，已停止自动派发',
          );
          continue;
        }
        if (terminal(d.status)) {
          const report = await this.db.reports.where('discussionId').equals(d.id).first();
          if (!report || report.status !== d.status || report.createdAt < d.updatedAt)
            await new ReportGenerator(this.db).generate(d.id);
          continue;
        }
        if (d.status === 'PAUSED' || d.status === 'CREATED') continue;
        try {
          if (d.status === 'FINALIZING') {
            await this.finalize(d.id);
            continue;
          }
          await this.engine.advance(d.id);
          // Same tick: advance may enter FINALIZING; finalize immediately so chat can show 查看详情.
          const after = await this.db.discussions.get(d.id);
          if (after?.status === 'FINALIZING') await this.finalize(d.id);
        } catch (error) {
          await log(
            this.db,
            'error',
            error instanceof CouncilError ? error.code : 'ENGINE_FAILURE',
            d.id,
            d.id,
          );
          await new TaskManager(this.db).pause(
            d.id,
            error instanceof CouncilError ? error.code : 'ENGINE_FAILURE',
          );
        }
      }
      const open = (await this.db.discussions.toArray()).filter(
        (d) => !terminal(d.status) && d.status !== 'PAUSED' && d.status !== 'CREATED',
      );
      const active = new Set(open.filter((d) => d.status !== 'FINALIZING').map((d) => d.id));
      const queue = (await this.db.task_queue.toArray())
        .filter(
          (t) =>
            active.has(t.discussionId) &&
            t.status !== 'done' &&
            t.status !== 'failed' &&
            t.nextRetryAt <= Date.now() &&
            t.leaseUntil <= Date.now(),
        )
        .sort(
          (a, b) =>
            a.nextRetryAt - b.nextRetryAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        );
      const task = queue[0];
      if (task) await this.runTask(task);
      for (const d of await this.db.discussions.toArray()) {
        if (d.status === 'FINALIZING') await this.finalize(d.id);
      }
    } finally {
      try {
        if (acquired)
          await this.db.transaction('rw', this.db.leases, async () => {
            const lease = await this.db.leases.get('scheduler');
            if (lease?.owner === this.owner) await this.db.leases.delete('scheduler');
          });
      } finally {
        this.busy = false;
      }
    }
  }
  private async finalize(id: string): Promise<void> {
    const discussion = requireValue(await this.db.discussions.get(id), '任务不存在');
    if (discussion.status !== 'FINALIZING') return;
    await new TaskManager(this.db).transition(
      id,
      'COMPLETED',
      discussion.mode === 'direct' ? 'DIRECT_RESPONSES_RECEIVED' : 'CONSENSUS_REACHED',
    );
    try {
      await new ReportGenerator(this.db).generate(id);
      await log(this.db, 'info', 'REPORT_READY', id, id);
    } catch (error) {
      await log(
        this.db,
        'warn',
        'REPORT_FAILED',
        error instanceof CouncilError ? error.code : String(error),
        id,
      );
    }
  }
  private async runTask(task: QueueTask): Promise<void> {
    const tasks = new TaskManager(this.db);
    const discussion = requireValue(await this.db.discussions.get(task.discussionId), '任务不存在');
    try {
      if (
        terminal(discussion.status) ||
        discussion.status === 'PAUSED' ||
        !(await new RequestCoordinator(this.db).isCurrent(discussion.userRequestId))
      )
        return;
      const cached = await this.gate.cachedResponse(task);
      if (cached) {
        await this.consume(task, cached);
        return;
      }
      const phase =
        task.status === 'pending'
          ? task.taskType === 'initial'
            ? 'initial'
            : 'verified'
          : 'observe';
      let adapter = await this.gate.requireReady(task.participantId, phase, task.discussionId);
      const current = await this.db.discussions.get(task.discussionId);
      if (!current || terminal(current.status) || current.status === 'PAUSED') return;
      if (task.status === 'sending') {
        const known = await bounded(adapter.reconcile(task, task.dedupeKey));
        if (known.state === 'unknown') {
          await this.awaitConfirmation(task);
          return;
        }
        if (known.state === 'submitted') {
          await this.db.task_queue.update(task.id, {
            status: 'waiting',
            receiptId: known.receipt.id,
            startedAt: known.receipt.submittedAt,
            leaseUntil: 0,
            nextRetryAt: Date.now(),
            lastError: undefined,
            confirmationAttempts: 0,
            updatedAt: Date.now(),
          });
          await this.db.messages.update(task.messageId, { status: 'delivered' });
          await log(this.db, 'info', 'DELIVERY_RECONCILED', task.id, task.discussionId);
          return;
        }
        task.status = 'pending';
        await this.db.task_queue.update(task.id, {
          status: 'pending',
          leaseUntil: 0,
          confirmationAttempts: 0,
        });
      }
      if (task.status === 'pending') {
        // Reconciliation proving no dispatch returns to the send gate; polling permission cannot authorize sending.
        if (phase === 'observe')
          adapter = await this.gate.requireReady(
            task.participantId,
            task.taskType === 'initial' ? 'initial' : 'verified',
            task.discussionId,
          );
        const message = requireValue(
          await this.db.messages.get(task.messageId),
          '待发送消息不存在',
        );
        if (discussion.mode === 'direct' && message.content !== discussion.originalQuestion) {
          if (await this.db.browser_deliveries.get(task.dedupeKey))
            throw new CouncilError(
              'LEGACY_DIRECT_REQUEST',
              '旧直问含历史提示且已有发送凭据，已保留记录；请发起本次新问题',
            );
          message.content = discussion.originalQuestion;
          await this.db.messages.update(message.id, { content: message.content });
          await log(this.db, 'info', 'DIRECT_PROMPT_NORMALIZED', message.id, task.discussionId);
        }
        await this.db.task_queue.update(task.id, {
          status: 'sending',
          leaseUntil: Date.now() + 20_000,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
        await log(this.db, 'info', 'SEND_STARTED', task.id, task.discussionId);
        let receipt;
        try {
          receipt = await bounded(adapter.submit(task, message.content, task.dedupeKey));
        } catch (error) {
          if (
            error instanceof CouncilError &&
            error.code === 'SESSION_INITIALIZING' &&
            error.safeToRetry
          ) {
            await this.db.task_queue.update(task.id, {
              status: 'pending',
              lastError: error.code,
              nextRetryAt: Date.now() + 1000,
              leaseUntil: 0,
              updatedAt: Date.now(),
            });
            await log(this.db, 'info', 'SESSION_WAITING', task.id, task.discussionId);
            return;
          }
          if (error instanceof CouncilError && error.safeToRetry && !error.retryable) {
            await this.db.task_queue.update(task.id, {
              status: 'pending',
              leaseUntil: 0,
              lastError: error.code,
            });
            throw error;
          }
          if (error instanceof CouncilError && error.retryable && error.safeToRetry) {
            await this.safeRetry(task, discussion.maxRetries, error.code, 'pending');
            return;
          }
          await this.db.task_queue.update(task.id, {
            lastError: 'DELIVERY_UNKNOWN',
            leaseUntil: 0,
            confirmationAttempts: 0,
            nextRetryAt: Date.now() + 2000,
            updatedAt: Date.now(),
          });
          await log(this.db, 'warn', 'DELIVERY_CHECK_PENDING', task.id, task.discussionId);
          return;
        }
        if (!receipt.id || !Number.isFinite(receipt.submittedAt))
          throw new CouncilError('INVALID_RECEIPT', '发送凭据无效');
        await this.db.transaction(
          'rw',
          [this.db.task_queue, this.db.messages, this.db.logs],
          async () => {
            await this.db.task_queue.update(task.id, {
              status: 'waiting',
              receiptId: receipt.id,
              startedAt: receipt.submittedAt,
              leaseUntil: 0,
              nextRetryAt: Date.now(),
              lastError: undefined,
              confirmationAttempts: 0,
              updatedAt: Date.now(),
            });
            await this.db.messages.update(task.messageId, { status: 'delivered' });
            await log(this.db, 'info', 'MESSAGE_DELIVERED', task.id, task.discussionId);
          },
        );
        return;
      }
      const receiptId = requireValue(task.receiptId, '缺少发送凭据，禁止盲目重发');
      const response = await bounded(
        adapter.poll(task, { id: receiptId, submittedAt: task.startedAt ?? task.createdAt }),
      );
      if (response.state === 'pending') {
        if (Date.now() - (task.startedAt ?? task.createdAt) > discussion.timeoutMs) {
          await this.safeRetry(task, discussion.maxRetries, 'TIMEOUT', 'waiting');
          return;
        }
        await this.db.task_queue.update(task.id, {
          nextRetryAt: Date.now() + 1000,
          updatedAt: Date.now(),
        });
        return;
      }
      if (response.state !== 'complete') {
        throw new CouncilError(
          response.state === 'logged_out'
            ? 'LOGGED_OUT'
            : response.state === 'restricted'
              ? 'AUTOMATION_BLOCKED'
              : 'PAGE_UNAVAILABLE',
          '网页需要处理；已保留发送凭据',
        );
      }
      await this.consume(task, response);
    } catch (error) {
      const code = error instanceof CouncilError ? error.code : 'ADAPTER_FAILURE';
      if (task.status === 'pending' && isPagePreparationPending(code)) {
        const deadline = task.preflightDeadline ?? Date.now() + PAGE_STARTUP_TIMEOUT_MS;
        if (Date.now() < deadline) {
          await this.db.task_queue.update(task.id, {
            preflightDeadline: deadline,
            nextRetryAt: Date.now() + 1000,
            leaseUntil: 0,
            lastError: code,
            updatedAt: Date.now(),
          });
          await log(this.db, 'info', 'PAGE_PREPARATION_WAIT', task.id, task.discussionId);
          return;
        }
      }
      if (
        task.status === 'sending' &&
        (code === 'OPERATION_TIMEOUT' || (error instanceof CouncilError && error.retryable))
      ) {
        await this.awaitConfirmation(task, code);
        return;
      }
      if (
        task.status === 'waiting' &&
        (code === 'OPERATION_TIMEOUT' || (error instanceof CouncilError && error.retryable))
      ) {
        await this.safeRetry(task, discussion.maxRetries, code, 'waiting');
        return;
      }
      await log(this.db, 'error', code, task.id, task.discussionId);
      if (code === 'LOGGED_OUT')
        await this.db.participants.update(task.participantId, {
          status: 'logged_out',
          reason: '网页已退出登录，等待用户自行登录。',
          updatedAt: Date.now(),
        });
      const d = await this.db.discussions.get(task.discussionId);
      const participant = await this.db.participants.get(task.participantId);
      if (d && !terminal(d.status) && d.status !== 'PAUSED')
        await tasks.pause(
          task.discussionId,
          code,
          `${participant?.name ?? task.participantId}：${errorText(error)}`,
        );
    }
  }
  private async consume(task: QueueTask, response: CompletedResponse): Promise<void> {
    const message = await new MessageManager(this.db).receive(
      task,
      response.externalMessageId,
      response.raw,
    );
    // ResponseProcessor owns its atomic transaction. A rejected nested transaction would abort
    // an enclosing one too and turn protocol rejection into TransactionInactiveError.
    const d = requireValue(await this.db.discussions.get(task.discussionId), '任务不存在');
    if (!terminal(d.status)) {
      if (d.mode === 'direct')
        await this.db.messages.update(message.id, {
          type: 'RESPONSE',
          parseStatus: 'not_applicable',
          structuredData: undefined,
          parseError: undefined,
        });
      else await new ResponseProcessor(this.db).process(message, task);
    }
    await this.db.transaction('rw', [this.db.task_queue, this.db.logs], async () => {
      // Applying is idempotent if the worker stops before this acknowledgement.
      await this.db.task_queue.update(task.id, {
        status: 'done',
        leaseUntil: 0,
        lastError: undefined,
        updatedAt: Date.now(),
      });
      await log(this.db, 'info', 'RESPONSE_RECEIVED', message.id, task.discussionId);
    });
  }
  private async awaitConfirmation(task: QueueTask, code = 'DELIVERY_UNKNOWN'): Promise<void> {
    const attempts = (task.confirmationAttempts ?? 0) + 1;
    await this.db.task_queue.update(task.id, {
      status: 'sending',
      confirmationAttempts: attempts,
      lastError: 'DELIVERY_UNKNOWN',
      leaseUntil: 0,
      nextRetryAt: Date.now() + Math.min(10_000, 2000 * attempts),
      updatedAt: Date.now(),
    });
    await log(
      this.db,
      'warn',
      'DELIVERY_CHECK_PENDING',
      `${task.id}: ${attempts}/5; ${code}`,
      task.discussionId,
    );
    if (attempts >= 5)
      await new TaskManager(this.db).pause(
        task.discussionId,
        'DELIVERY_UNKNOWN',
        '已进行 5 次只读发送核对，仍未确认本请求标记。已保留原标签页和发送记录，没有重复发送；请保留讨论页并核对其是否显示完整的用户消息。',
      );
  }
  private async safeRetry(
    task: QueueTask,
    max: number,
    code: string,
    status: 'pending' | 'waiting',
  ): Promise<void> {
    const count = task.retryCount + 1;
    await this.db.transaction(
      'rw',
      [this.db.task_queue, this.db.messages, this.db.logs],
      async () => {
        await this.db.task_queue.update(task.id, {
          status: count > max ? 'failed' : status,
          retryCount: count,
          nextRetryAt: Date.now() + Math.min(30_000, 1000 * 2 ** count),
          leaseUntil: 0,
          lastError: status === 'pending' ? `SAFE_SEND_FAILED:${code}` : code,
          ...(status === 'waiting' ? { startedAt: Date.now() } : {}),
          updatedAt: Date.now(),
        });
        if (count > max) await this.db.messages.update(task.messageId, { status: 'failed' });
        await log(
          this.db,
          count > max ? 'error' : 'warn',
          count > max ? 'RETRIES_EXHAUSTED' : 'RETRY_SCHEDULED',
          `${task.id}: ${code}, attempt ${count}`,
          task.discussionId,
        );
      },
    );
    if (count > max)
      await new TaskManager(this.db).pause(task.discussionId, `${code}:RETRIES_EXHAUSTED`);
  }
}
