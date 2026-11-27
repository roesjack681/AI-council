import type { CouncilDB } from '../database/db';
import Dexie from 'dexie';
import type { Discussion, Round, QueueTask } from '../protocols/domain';
import { ComplianceGate } from '../adapters/base/compliance-gate';
import { TaskManager, terminal } from './task-manager';
import { MessageManager } from './message-manager';
import { buildContext } from './context-manager';
import { generatePrompt } from './prompt-generator';
import { evaluateConsensus } from './consensus-engine';
import { digest, newId } from '../utils/id';
import { CouncilError, requireValue, errorText } from '../utils/errors';
import { log } from '../utils/logger';
import { RequestCoordinator } from './request-coordinator';
import { isPagePreparationPending, PAGE_STARTUP_TIMEOUT_MS } from './page-readiness';

export class DiscussionEngine {
  private readonly tasks: TaskManager;
  private readonly messages: MessageManager;
  constructor(
    private readonly db: CouncilDB,
    private readonly gate: ComplianceGate,
  ) {
    this.tasks = new TaskManager(db);
    this.messages = new MessageManager(db);
  }
  async start(id: string): Promise<void> {
    let d = requireValue(await this.db.discussions.get(id), '任务不存在');
    if (!(await new RequestCoordinator(this.db).isCurrent(d.userRequestId)))
      throw new CouncilError('REQUEST_SUPERSEDED', '旧问题未经明确恢复不能再次启动');
    if (d.status === 'PAUSED') {
      try {
        const phase = ['CREATED', 'INITIALIZING', 'INITIAL_ANSWERS'].includes(d.resumeStatus ?? '')
          ? 'initial'
          : 'verified';
        const queued = await this.db.task_queue.where('discussionId').equals(id).toArray();
        for (const pid of d.participantIds) {
          const outstanding = queued.filter(
            (task) => task.participantId === pid && !['done', 'failed'].includes(task.status),
          );
          if (
            outstanding.length &&
            (await Promise.all(outstanding.map((task) => this.gate.cachedResponse(task)))).every(
              Boolean,
            )
          )
            continue;
          const awaiting = queued.some(
            (task) => task.participantId === pid && ['waiting', 'sending'].includes(task.status),
          );
          await this.gate.requireReady(pid, awaiting ? 'observe' : phase, id);
        }
      } catch (error) {
        if (error instanceof CouncilError && isPagePreparationPending(error.code)) {
          await this.tasks.resume(id);
          await this.db.discussions.update(id, { startup: undefined });
          return;
        }
        await this.tasks.pause(
          id,
          error instanceof CouncilError ? error.code : 'CAPABILITY_CHECK_FAILED',
          errorText(error),
        );
        throw error;
      }
      await this.tasks.resume(id);
      d = requireValue(await this.db.discussions.get(id), '任务不存在');
    }
    if (d.status !== 'CREATED' && d.status !== 'INITIALIZING') return;
    if (d.status === 'CREATED') await this.tasks.transition(id, 'INITIALIZING');
    const now = Date.now();
    const startup = d.startup ?? {
      startedAt: now,
      deadline: now + PAGE_STARTUP_TIMEOUT_MS,
      nextCheckAt: now,
      attempts: 0,
    };
    if (startup.nextCheckAt > now) return;
    await this.db.discussions.update(id, { startup });
    try {
      for (const pid of d.participantIds) await this.gate.requireReady(pid, 'initial', id);
    } catch (error) {
      const code = error instanceof CouncilError ? error.code : 'CAPABILITY_CHECK_FAILED';
      if (isPagePreparationPending(code) && now < startup.deadline) {
        await this.db.discussions.update(id, {
          startup: {
            ...startup,
            attempts: startup.attempts + 1,
            nextCheckAt: Date.now() + 1000,
            lastCode: code,
          },
          reason: 'STARTING_PAGES',
          reasonDetail: '正在自动准备模型网页，加载完成后自动继续。',
        });
        await log(this.db, 'info', 'PAGE_PREPARATION_WAIT', code, id);
        return;
      }
      await this.tasks.pause(
        id,
        error instanceof CouncilError ? error.code : 'CAPABILITY_CHECK_FAILED',
        errorText(error),
      );
      return;
    }
    await this.db.transaction('rw', this.db.tables, async () => {
      const round = await this.makeRound(d, 0, 'initial');
      for (const pid of d.participantIds)
        await this.messages.enqueue(
          id,
          pid,
          round,
          generatePrompt(d, 'initial', undefined, '', { participantId: pid }),
          'initial',
          'initial',
        );
      await this.tasks.transition(id, 'INITIAL_ANSWERS');
      await this.db.discussions.update(id, { startup: undefined });
    });
  }
  private async makeRound(d: Discussion, n: number, kind: Round['kind']): Promise<Round> {
    const prior = await this.db.rounds
      .where('[discussionId+roundNumber]')
      .equals([d.id, n])
      .first();
    if (prior) return prior;
    const r: Round = {
      id: newId(),
      discussionId: d.id,
      roundNumber: n,
      kind,
      status: 'active',
      summary: '',
      startedAt: Date.now(),
    };
    await this.db.rounds.add(r);
    await this.db.discussions.update(d.id, { currentRound: n, updatedAt: Date.now() });
    return r;
  }
  async advance(id: string): Promise<void> {
    const d = requireValue(await this.db.discussions.get(id), '任务不存在');
    if (d.status === 'CREATED' || d.status === 'INITIALIZING') {
      await this.start(id);
      return;
    }
    await this.db.transaction('rw', this.db.tables, () => this.advanceRunning(id));
  }
  private async advanceRunning(id: string): Promise<void> {
    const d = requireValue(await this.db.discussions.get(id), '任务不存在');
    if (terminal(d.status) || d.status === 'PAUSED') return;
    if (d.status === 'CREATED' || d.status === 'INITIALIZING') {
      await this.start(id);
      return;
    }
    if (d.status === 'FINALIZING') return;
    const queue = await this.db.task_queue.where('discussionId').equals(id).toArray();
    if (queue.some((t) => t.status === 'failed')) {
      await this.tasks.pause(id, 'QUEUE_FAILED');
      return;
    }
    if (queue.some((t) => t.status !== 'done')) return;
    const round = requireValue(
      await this.db.rounds.where('[discussionId+roundNumber]').equals([id, d.currentRound]).first(),
      '当前轮次不存在',
    );
    const incoming = (await this.db.messages.where('roundId').equals(round.id).toArray()).filter(
      (m) => m.direction === 'inbound',
    );
    const malformed = incoming.filter((m) => m.parseStatus === 'PARSE_FAILED');
    const uncorrected = malformed.filter(
      (m) =>
        !incoming.some(
          (other) =>
            other.participantId === m.participantId &&
            other.parseStatus === 'valid' &&
            other.createdAt >= m.createdAt,
        ),
    );
    if (uncorrected.length) {
      const repairContext = await buildContext(this.db, d);
      for (const m of uncorrected) {
        const repairs = queue.filter(
          (t) =>
            t.roundId === round.id &&
            t.participantId === m.participantId &&
            t.taskType === 'repair',
        );
        if (repairs.length >= 2) {
          await this.tasks.pause(id, 'PARSE_FAILED');
          return;
        }
        await this.messages.enqueue(
          id,
          m.participantId,
          round,
          generatePrompt(
            d,
            'repair',
            repairContext,
            `${m.parseError ? `校验失败：${m.parseError.code}；${m.parseError.detail}\n` : ''}${m.content}`,
            { participantId: m.participantId },
          ),
          'repair',
          `repair:${m.id}`,
        );
      }
      return;
    }
    const context = await buildContext(this.db, d);
    if (round.status !== 'completed')
      await this.db.rounds.update(round.id, {
        status: 'completed',
        completedAt: Date.now(),
        summary: context.summary,
      });
    if (d.status === 'INITIAL_ANSWERS') {
      const answered = new Set(
        incoming
          .filter(
            (m) =>
              m.parseStatus === 'valid' ||
              (d.mode === 'direct' && m.parseStatus === 'not_applicable'),
          )
          .map((m) => m.participantId),
      );
      if (!d.participantIds.every((pid) => answered.has(pid))) {
        await this.tasks.pause(id, 'MISSING_INITIAL_ANSWER');
        return;
      }
      if (d.mode === 'direct') {
        await this.tasks.transition(id, 'FINALIZING', 'DIRECT_RESPONSES_RECEIVED');
        return;
      }
      await this.tasks.transition(id, 'FREE_DISCUSSION');
      await this.scheduleRound(d, 1, 'review', d.participantIds, 'review', '交叉审查所有独立答案');
      return;
    }
    if (d.status === 'FREE_DISCUSSION') await this.tasks.transition(id, 'OBJECTION_REVIEW');
    if (d.status === 'FREE_DISCUSSION' || d.status === 'OBJECTION_REVIEW')
      await this.tasks.transition(id, 'CONSENSUS_CHECK');
    const previous = (
      await this.db.consensus_records.where('discussionId').equals(id).toArray()
    ).sort((a, b) => b.roundNumber - a.roundNumber)[0];
    const existing = await this.db.consensus_records
      .where('[discussionId+roundNumber]')
      .equals([id, d.currentRound])
      .first();
    const result =
      existing ??
      (await Dexie.waitFor(
        evaluateConsensus({
          discussion: d,
          claims: context.claims,
          objections: context.objections,
          positions: context.positions,
          facts: context.facts,
          previous,
        }),
      ));
    if (!existing) await this.db.consensus_records.add(result);
    if (result.reached) {
      await this.tasks.transition(id, 'FINALIZING', 'CONSENSUS_REACHED');
      return;
    }
    if (d.currentRound >= d.maxRounds) {
      await this.tasks.transition(id, 'UNRESOLVED', 'MAX_ROUNDS');
      return;
    }
    const progress = await Dexie.waitFor(
      digest(
        JSON.stringify({
          claims: context.claims.map((c) => [c.id, c.version]).sort(),
          objections: context.objections
            .map((o) => [
              o.id,
              o.status,
              o.reviews.map((r) => [r.participantId, r.action, r.claimVersion]),
            ])
            .sort(),
          positions: context.positions
            .map((p) => [p.participantId, p.claimId, p.claimVersion, p.position, p.conditions])
            .sort(),
          facts: context.facts.map((f) => [f.id, f.verificationStatus]).sort(),
        }),
      ),
    );
    const stalled = progress === d.lastProgressFingerprint ? d.noProgressRounds + 1 : 0;
    await this.db.discussions.update(id, {
      lastProgressFingerprint: progress,
      noProgressRounds: stalled,
    });
    if (stalled >= 3) {
      await this.tasks.transition(id, 'UNRESOLVED', 'STALLED');
      return;
    }
    const pendingEvents: { participantId: string; key: string; text: string }[] = [];
    for (const objection of context.objections.filter((o) => o.status !== 'resolved')) {
      const claim = context.claims.find((c) => c.id === objection.relatedClaimId);
      const recipients = [
        ...new Set([...objection.targetParticipantIds, objection.sourceParticipantId]),
      ];
      for (const pid of recipients) {
        const key = `objection:${objection.id}:v${claim?.version ?? 0}:${pid}`;
        const dedupe = await Dexie.waitFor(digest(JSON.stringify([id, pid, key])));
        if (!queue.some((t) => t.dedupeKey === dedupe))
          pendingEvents.push({
            participantId: pid,
            key,
            text: `请回应争议 ${objection.id}，当前结论 v${claim?.version}。${objection.description}`,
          });
      }
    }
    await this.tasks.transition(id, 'FREE_DISCUSSION');
    if (pendingEvents.length) {
      await this.scheduleEvents(d, d.currentRound + 1, pendingEvents);
    } else
      await this.scheduleRound(
        d,
        d.currentRound + 1,
        'confirmation',
        d.participantIds,
        'confirmation',
        result.reasons.join('；'),
      );
  }
  private async scheduleRound(
    d: Discussion,
    n: number,
    kind: Round['kind'],
    ids: string[],
    type: QueueTask['taskType'],
    event: string,
  ): Promise<void> {
    const context = await buildContext(this.db, d);
    const prompts = ids.map((pid) => ({
      pid,
      prompt: generatePrompt(d, type, context, event, { participantId: pid }),
    }));
    await this.db.transaction('rw', this.db.tables, async () => {
      const round = await this.makeRound(d, n, kind);
      for (const { pid, prompt } of prompts)
        await this.messages.enqueue(d.id, pid, round, prompt, type, `${type}:round:${n}`);
      await log(this.db, 'info', 'ROUND_SCHEDULED', `${n}: ${type}`, d.id);
    });
  }
  private async scheduleEvents(
    d: Discussion,
    n: number,
    events: { participantId: string; key: string; text: string }[],
  ): Promise<void> {
    const context = await buildContext(this.db, d);
    const prompts = events.map((e) => ({
      ...e,
      prompt: generatePrompt(d, 'event', context, e.text, { participantId: e.participantId }),
    }));
    await this.db.transaction('rw', this.db.tables, async () => {
      const round = await this.makeRound(d, n, 'event');
      for (const e of prompts)
        await this.messages.enqueue(d.id, e.participantId, round, e.prompt, 'event', e.key);
      await log(this.db, 'info', 'EVENT_ROUND_SCHEDULED', String(n), d.id);
    });
  }
}
