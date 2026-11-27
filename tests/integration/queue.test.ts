import { afterEach, describe, it, expect, vi } from 'vitest';
import { fixture, tick, agreeingResponse, envelope, type Fixture } from '../fixtures/council';
import { MessageManager } from '../../src/core/message-manager';
import { TaskManager } from '../../src/core/task-manager';
import { recover } from '../../src/background/recovery';
let f: Fixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await f?.cleanup();
  f = undefined;
});
describe('durable queue and failure handling', () => {
  it('recovers a durably completed local response when the webpage is no longer available', async () => {
    f = await fixture(1);
    const fx = f;
    const d = await fx.create({ mode: 'direct', stableRoundsRequired: 1, maxRounds: 1 });
    await fx.service.engine.start(d.id);
    await tick(fx);
    const queued = (await fx.db.task_queue.toArray())[0]!;
    expect(queued.status).toBe('waiting');
    Object.assign(fx.adapter, {
      cachedResponse: async () => ({
        state: 'complete' as const,
        externalMessageId: 'LOCAL COMPLETED RESPONSE',
        raw: JSON.stringify(envelope({ type: 'INITIAL_ANSWER' })),
      }),
    });
    fx.adapter.allowed = false;
    await new TaskManager(fx.db).pause(d.id, 'TEST RESTART');
    await fx.service.engine.start(d.id);
    await tick(fx, 3);
    expect((await fx.db.discussions.get(d.id))?.status).toBe('COMPLETED');
    expect(fx.adapter.submitCalls).toBe(1);
    expect(fx.adapter.pollCalls).toBe(0);
  });
  it('rejects invalid response references without aborting the queue transaction and repairs using current IDs', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.answer = async (task) =>
      task.taskType === 'initial'
        ? agreeingResponse(fx, task)
        : JSON.stringify(
            envelope({
              positions: [
                {
                  claimId: 'missing-claim',
                  version: 1,
                  position: 'AGREE',
                  reason: 'TEST specific reason for invalid reference',
                  final: true,
                  conditions: [],
                },
              ],
            }),
          );
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    for (let i = 0; i < 20; i++) {
      await tick(fx);
      if ((await fx.db.task_queue.toArray()).some((task) => task.taskType === 'repair')) break;
    }
    expect((await fx.db.discussions.get(d.id))?.status).not.toBe('PAUSED');
    const malformed = (await fx.db.messages.toArray()).filter(
      (m) => m.direction === 'inbound' && m.parseStatus === 'PARSE_FAILED',
    );
    expect(malformed.length).toBeGreaterThan(0);
    const repair = (await fx.db.task_queue.toArray()).find((task) => task.taskType === 'repair')!;
    const prompt = (await fx.db.messages.get(repair.messageId))!.content;
    const claim = (await fx.db.claims.toArray())[0]!;
    expect(prompt).toContain(claim.id);
    expect(prompt).toContain('当前版本');
    expect((await fx.db.logs.toArray()).some((entry) => entry.code === 'ADAPTER_FAILURE')).toBe(
      false,
    );
  });
  it('T07 idempotent enqueue and exact response IDs deduplicate', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    const round = (await f.db.rounds.toArray())[0]!;
    const manager = new MessageManager(f.db);
    const [a, b] = await Promise.all([
      manager.enqueue(
        d.id,
        f.ids[0]!,
        round,
        'different payload cannot change a queued prompt',
        'initial',
        'initial',
      ),
      manager.enqueue(d.id, f.ids[0]!, round, 'duplicate', 'initial', 'initial'),
    ]);
    expect(a.id).toBe(b.id);
    expect(await f.db.task_queue.count()).toBe(2);
    const m = await manager.receive(a, 'TEST EXTERNAL ID', 'TEST RAW');
    expect((await manager.receive(a, 'TEST EXTERNAL ID', 'TEST RAW')).id).toBe(m.id);
  });
  it('T15 retries only explicitly not-sent failures, bounded and logged', async () => {
    f = await fixture();
    f.adapter.safeFailures = 20;
    const d = await f.create({ maxRetries: 1 });
    await f.service.engine.start(d.id);
    await tick(f, 10);
    expect((await f.db.discussions.get(d.id))?.status).toBe('PAUSED');
    expect(f.adapter.submitCalls).toBe(2);
    expect((await f.db.logs.toArray()).some((l) => l.code === 'RETRIES_EXHAUSTED')).toBe(true);
    expect((await f.db.task_queue.toArray()).some((q) => q.status === 'failed')).toBe(true);
  });
  it('ack loss is reconciled using the persisted key without resubmitting', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.loseAck = true;
    fx.adapter.answer = (t) => agreeingResponse(fx, t);
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    await tick(fx);
    expect((await fx.db.discussions.get(d.id))?.status).toBe('INITIAL_ANSWERS');
    expect(fx.adapter.submitCalls).toBe(1);
    const sending = (await fx.db.task_queue.toArray()).find((q) => q.status === 'sending')!;
    await fx.db.task_queue.toCollection().modify((q) => {
      q.nextRetryAt = q.id === sending.id ? 0 : Date.now() + 60_000;
    });
    await fx.service.scheduler.tick();
    expect(fx.adapter.submitCalls).toBe(1);
    const confirmed = await fx.db.task_queue.get(sending.id);
    expect(confirmed?.status).toBe('waiting');
    expect(confirmed?.lastError).toBeUndefined();
    expect((await fx.db.logs.toArray()).some((l) => l.code === 'DELIVERY_RECONCILED')).toBe(true);
  });
  it('unknown delivery remains paused instead of replaying', async () => {
    f = await fixture();
    f.adapter.loseAck = true;
    f.adapter.unknown = true;
    const d = await f.create();
    await f.service.engine.start(d.id);
    await tick(f);
    const sending = (await f.db.task_queue.toArray()).find((q) => q.status === 'sending')!;
    for (let i = 0; i < 5; i++) {
      await f.db.task_queue.toCollection().modify((q) => {
        q.nextRetryAt = q.id === sending.id ? 0 : Date.now() + 60_000;
      });
      await f.service.scheduler.tick();
    }
    expect(f.adapter.submitCalls).toBe(1);
    expect((await f.db.discussions.get(d.id))?.reason).toBe('DELIVERY_UNKNOWN');
    expect((await f.db.task_queue.get(sending.id))?.confirmationAttempts).toBe(5);
    expect((await f.db.discussions.get(d.id))?.reasonDetail).toContain('没有重复发送');
  });
  it('resumes legacy sending and waiting records without resetting them to unsent work', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.loseAck = true;
    fx.adapter.answer = (t) => agreeingResponse(fx, t);
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    await tick(fx);
    const sending = (await fx.db.task_queue.toArray()).find((q) => q.status === 'sending')!;
    await new TaskManager(fx.db).pause(d.id, 'DELIVERY_UNKNOWN');
    await fx.db.task_queue.update(sending.id, {
      confirmationAttempts: 5,
      nextRetryAt: Date.now() + 60_000,
    });
    await fx.service.engine.start(d.id);
    await fx.db.task_queue.toCollection().modify((q) => {
      q.nextRetryAt = q.id === sending.id ? 0 : Date.now() + 60_000;
    });
    await fx.service.scheduler.tick();
    expect(fx.adapter.submitCalls).toBe(1);
    expect((await fx.db.task_queue.get(sending.id))?.status).toBe('waiting');
    await fx.db.task_queue.update(sending.id, {
      startedAt: 1,
      lastError: 'SAFE_SEND_FAILED:PAGE_CHECK_FAILED',
    });
    await new TaskManager(fx.db).pause(d.id);
    await fx.service.engine.start(d.id);
    expect((await fx.db.task_queue.get(sending.id))?.startedAt).toBeGreaterThan(1);
    await fx.db.task_queue.toCollection().modify((q) => {
      q.nextRetryAt = q.id === sending.id ? 0 : Date.now() + 60_000;
    });
    await fx.service.scheduler.tick();
    expect(fx.adapter.submitCalls).toBe(1);
    expect((await fx.db.task_queue.get(sending.id))?.status).toBe('done');
    expect((await fx.db.task_queue.get(sending.id))?.lastError).toBeUndefined();
  });
  it('clears a past safe-send failure after the same request is actually delivered', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.safeFailures = 1;
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    await tick(fx);
    const target = (await fx.db.task_queue.toArray()).find((q) =>
      q.lastError?.startsWith('SAFE_SEND_FAILED:'),
    )!;
    expect(target.status).toBe('pending');
    await fx.db.task_queue.toCollection().modify((q) => {
      q.nextRetryAt = q.id === target.id ? 0 : Date.now() + 60_000;
    });
    await fx.service.scheduler.tick();
    const waiting = await fx.db.task_queue.get(target.id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.retryCount).toBe(1);
    expect(waiting?.lastError).toBeUndefined();
    expect((await fx.db.logs.toArray()).some((l) => l.code === 'RETRY_SCHEDULED')).toBe(true);
  });
  it('continues read-only polling and recovery while a DOM model is generating', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.pending = true;
    fx.adapter.answer = (t) => agreeingResponse(fx, t);
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    await tick(fx);
    await fx.db.task_queue.toCollection().modify((q) => {
      q.nextRetryAt = q.status === 'pending' ? 0 : Date.now() + 60_000;
    });
    await fx.service.scheduler.tick();
    expect((await fx.db.task_queue.toArray()).every((q) => q.status === 'waiting')).toBe(true);
    const inspect = fx.adapter.inspect.bind(fx.adapter);
    let generating = true;
    vi.spyOn(fx.adapter, 'inspect').mockImplementation(async () => {
      const check = await inspect();
      return generating
        ? {
            ...check,
            interactionMode: 'browser_dom',
            technicalVerified: false,
            failureCode: 'PAGE_BUSY',
            capabilities: { ...check.capabilities, unattendedAllowed: false },
          }
        : check;
    });
    await recover(fx.db, fx.service.gate);
    expect((await fx.db.discussions.get(d.id))?.status).toBe('INITIAL_ANSWERS');
    await tick(fx);
    expect(fx.adapter.pollCalls).toBe(1);
    expect(fx.adapter.submitCalls).toBe(2);
    expect((await fx.db.discussions.get(d.id))?.status).toBe('INITIAL_ANSWERS');
    expect(
      (await fx.db.participants.toArray()).every((p) => p.capabilities.unattendedAllowed === false),
    ).toBe(true);
    generating = false;
    fx.adapter.pending = false;
    await tick(fx, 2);
    expect((await fx.db.messages.toArray()).filter((m) => m.direction === 'inbound')).toHaveLength(
      2,
    );
  });
  it('read-only reconciliation cannot become a new send when send capability is absent', async () => {
    f = await fixture();
    const fx = f;
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    const target = (await fx.db.task_queue.toArray())[0]!;
    await fx.db.task_queue.update(target.id, { status: 'sending' });
    await fx.db.task_queue.toCollection().modify((q) => {
      q.nextRetryAt = q.id === target.id ? 0 : Date.now() + 60_000;
    });
    const inspect = fx.adapter.inspect.bind(fx.adapter);
    vi.spyOn(fx.adapter, 'inspect').mockImplementation(async () => ({
      ...(await inspect()),
      interactionMode: 'browser_dom',
      technicalVerified: false,
      failureCode: 'OUTPUT_NOT_FOUND',
    }));
    await fx.service.scheduler.tick();
    expect(fx.adapter.submitCalls).toBe(0);
    expect((await fx.db.discussions.get(d.id))?.reason).toBe('OUTPUT_NOT_FOUND');
  });
  it('T08 timeout polls the same receipt; exhausted retries pause', async () => {
    f = await fixture();
    f.adapter.pending = true;
    const d = await f.create({ maxRetries: 0 });
    await f.service.engine.start(d.id);
    await tick(f);
    const q = (await f.db.task_queue.toArray()).find((x) => x.status === 'waiting')!;
    await f.db.task_queue.update(q.id, { startedAt: Date.now() - 2000 });
    await tick(f);
    expect((await f.db.discussions.get(d.id))?.reason).toContain('TIMEOUT');
    expect(f.adapter.submitCalls).toBe(1);
  });
  it('T12 logout pauses before sending and keeps original question', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    f.adapter.login = 'logged_out';
    await tick(f);
    expect((await f.db.discussions.get(d.id))?.reason).toBe('LOGGED_OUT');
    expect(f.adapter.submitCalls).toBe(0);
    expect((await f.db.participants.toArray()).some((p) => p.status === 'logged_out')).toBe(true);
  });
  it('capability revocation stops polling already delivered messages', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    await tick(f);
    f.adapter.allowed = false;
    await tick(f);
    expect(f.adapter.pollCalls).toBe(0);
    expect((await f.db.discussions.get(d.id))?.status).toBe('PAUSED');
  });
  it('cross-task response association is rejected', async () => {
    f = await fixture();
    const a = await f.create();
    const b = await f.create();
    await f.service.engine.start(a.id);
    await f.service.engine.start(b.id);
    const qs = await f.db.task_queue.toArray();
    const first = qs.find((q) => q.discussionId === a.id)!;
    const second = qs.find((q) => q.discussionId === b.id)!;
    const manager = new MessageManager(f.db);
    await manager.receive(first, 'external', 'raw');
    await expect(
      manager.receive(
        { ...second, discussionId: a.id, participantId: first.participantId },
        'external',
        'raw',
      ),
    ).rejects.toThrow('同一平台响应不能用于不同的请求');
  });
});
