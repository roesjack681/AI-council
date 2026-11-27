import { describe, it, expect, afterEach, vi } from 'vitest';
import { fixture, envelope, tick, browser, type Fixture } from '../fixtures/council';
import { CouncilService } from '../../src/services/council-service';
import { CouncilError } from '../../src/utils/errors';
import { isBrainDiscussion, type BrainRequest } from '../../src/protocols/domain';

async function finishBrainRoute(f: Fixture, maxTicks = 40): Promise<BrainRequest> {
  for (let i = 0; i < maxTicks; i++) {
    // Runner backs off with nextRetryAt; tests force due so ticks progress without real waits.
    await f.db.brain_requests.toCollection().modify({ nextRetryAt: 0 });
    await f.service.execute({ type: 'tick' });
    const job = [...(await f.db.brain_requests.toArray())].sort(
      (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    )[0];
    if (!job) continue;
    if (job.phase === 'done' || job.phase === 'paused' || job.phase === 'cancelled') return job;
  }
  const stuck = await f.db.brain_requests.toArray();
  throw new Error(
    `brain routing did not finish: ${stuck.map((j) => `${j.phase}/${j.error?.code ?? ''}`).join(';')}`,
  );
}

async function drainRouting(f: Fixture) {
  for (let i = 0; i < 12; i++) {
    await f.db.brain_requests.toCollection().modify({ nextRetryAt: 0 });
    const active = (await f.db.brain_requests.toArray()).some(
      (job) => !['done', 'paused', 'cancelled'].includes(job.phase),
    );
    if (!active) break;
    await f.service.execute({ type: 'tick' });
  }
  return (await f.db.brain_requests.toArray())[0]!;
}
const routingResponse = (target: string) =>
  JSON.stringify({
    intent: 'direct_ask',
    targets: [target],
    task: 'TEST ROUTED TASK',
    brief: 'TEST route selected the requested target only.',
    reason: 'TEST ROUTING RATIONALE',
  });

describe('brain ask orchestration', () => {
  const cleanups: Array<() => Promise<void>> = [];
  async function routedFixture() {
    const f = await fixture(2);
    cleanups.push(f.cleanup);
    await f.participants.updateProfile(f.ids[0]!, { role: 'brain' });
    f.adapter.answer = async (task) =>
      isBrainDiscussion(task.discussionId)
        ? routingResponse(f.ids[1]!)
        : JSON.stringify(envelope({ type: 'INITIAL_ANSWER' }));
    return f;
  }
  it('reconciles an unknown delivery five times, then resumes reading without replay', async () => {
    const f = await routedFixture();
    f.adapter.loseAck = true;
    f.adapter.unknown = true;
    await f.service.execute({ type: 'chat.ask', question: 'TEST UNKNOWN DELIVERY' });
    let job = await drainRouting(f);
    expect(job.phase).toBe('paused');
    expect(job.error?.code).toBe('DELIVERY_UNKNOWN');
    expect(job.confirmationAttempts).toBe(5);
    expect(f.adapter.submitCalls).toBe(1);
    f.adapter.unknown = false;
    f.adapter.loseAck = false;
    await f.service.execute({ type: 'brain.resume', id: job.id });
    job = await drainRouting(f);
    expect(job.phase).toBe('done');
    expect(
      [...f.adapter.submissions.keys()].filter((key) => key.startsWith('brain:')),
    ).toHaveLength(1);
  });
  it('repairs malformed routing JSON once using a new durable request key', async () => {
    const f = await routedFixture();
    let brainReplies = 0;
    f.adapter.answer = async (task) =>
      isBrainDiscussion(task.discussionId)
        ? ++brainReplies === 1
          ? 'TEST MALFORMED JSON'
          : routingResponse(f.ids[1]!)
        : JSON.stringify(envelope());
    await f.service.execute({ type: 'chat.ask', question: 'TEST ORIGINAL WORDS' });
    const job = await drainRouting(f);
    expect(job.phase).toBe('done');
    expect(job.repairCount).toBe(1);
    expect(
      [...f.adapter.submissions.keys()].filter((key) => key.startsWith('brain:')),
    ).toHaveLength(2);
    expect((await f.db.discussions.get(job.discussionId!))?.originalQuestion).toBe(
      'TEST ORIGINAL WORDS',
    );
  });
  it('safe pre-dispatch failures retry, while cancellation preserves records and releases the router', async () => {
    const f = await routedFixture();
    f.adapter.safeFailures = 1;
    f.adapter.pending = true;
    await f.service.execute({ type: 'chat.ask', question: 'TEST RETRY' });
    await f.service.execute({ type: 'tick' });
    let job = (await f.db.brain_requests.toArray())[0]!;
    expect(job.phase).toBe('pending');
    expect(job.retryCount).toBe(1);
    await f.db.brain_requests.toCollection().modify({ nextRetryAt: 0 });
    await f.service.execute({ type: 'tick' });
    job = (await f.db.brain_requests.toArray())[0]!;
    expect(job.receipt).toBeTruthy();
    expect((await f.service.execute({ type: 'participant.remove', id: f.ids[0]! })).ok).toBe(false);
    await expect(f.participants.updateProfile(f.ids[0]!, { role: 'council' })).rejects.toThrow(
      '完成或取消',
    );
    await expect(f.participants.updateProfile(f.ids[1]!, { role: 'brain' })).rejects.toThrow(
      '完成或取消',
    );
    expect((await f.service.execute({ type: 'brain.cancel', id: job.id })).ok).toBe(true);
    expect((await f.db.brain_requests.get(job.id))?.phase).toBe('cancelled');
    expect((await f.service.execute({ type: 'chat.ask', question: 'TEST NEW REQUEST' })).ok).toBe(
      true,
    );
  });
  it('returns a persisted routing request immediately and keeps snapshot commands responsive', async () => {
    const f = await routedFixture();
    f.adapter.pending = true;
    const result = await f.service.execute({
      type: 'chat.ask',
      question: 'TEST ORIGINAL QUESTION',
    });
    expect(result.ok).toBe(true);
    expect(f.adapter.pollCalls).toBe(0);
    expect(f.adapter.submitCalls).toBe(0);
    expect((await f.service.execute({ type: 'snapshot' })).ok).toBe(true);
    expect((await f.db.brain_requests.toArray())[0]?.phase).toBe('pending');
    const second = await f.service.execute({ type: 'chat.ask', question: 'SECOND QUESTION' });
    expect(second.ok).toBe(true);
    const jobs = await f.db.brain_requests.toArray();
    expect(jobs.find((j) => j.question === 'TEST ORIGINAL QUESTION')?.error?.code).toBe(
      'NEW_QUESTION',
    );
  });
  it('survives service restart after acknowledgement loss without repeating the routing send', async () => {
    const f = await routedFixture();
    f.adapter.loseAck = true;
    await f.service.execute({ type: 'chat.ask', question: 'TEST IMMUTABLE USER WORDS' });
    await f.service.execute({ type: 'tick' });
    expect((await f.db.brain_requests.toArray())[0]?.phase).toBe('sending');
    const restarted = new CouncilService(f.db, browser, f.registry);
    await restarted.initialize();
    await f.db.brain_requests.toCollection().modify({ nextRetryAt: 0 });
    await restarted.execute({ type: 'tick' });
    expect(f.adapter.submitCalls).toBe(1);
    expect((await f.db.brain_requests.toArray())[0]?.phase).toBe('waiting');
    f.adapter.loseAck = false;
    const job = await drainRouting(f);
    expect(job.phase).toBe('done');
    expect((await f.db.discussions.get(job.discussionId!))?.originalQuestion).toBe(
      'TEST IMMUTABLE USER WORDS',
    );
  });
  it('retains the linked discussion when routing fails after creation and resumes without creating a duplicate', async () => {
    const f = await routedFixture();
    vi.spyOn(f.service.engine, 'start').mockRejectedValueOnce(
      new CouncilError('TEST_RESTART', 'TEST simulated restart after creation'),
    );
    await f.service.execute({ type: 'chat.ask', question: 'TEST ORIGINAL' });
    let job = await drainRouting(f);
    expect(job.phase).toBe('paused');
    expect(job.discussionId).toBeTruthy();
    expect(await f.db.discussions.count()).toBe(1);
    await f.service.execute({ type: 'brain.resume', id: job.id });
    job = await drainRouting(f);
    expect(job.phase).toBe('done');
    expect(await f.db.discussions.count()).toBe(1);
  });
  it('does not silently expand an unknown named target into an all-member discussion', async () => {
    const f = await routedFixture();
    f.adapter.answer = async () => routingResponse('NONEXISTENT MEMBER');
    await f.service.execute({ type: 'chat.ask', question: 'TEST QUESTION' });
    const job = await drainRouting(f);
    expect(job.phase).toBe('paused');
    expect(job.error?.code).toBe('UNKNOWN_ROUTE_TARGET');
    expect(await f.db.discussions.count()).toBe(0);
  });
  it('timeouts keep receipts and explicit resume reads the original response', async () => {
    const f = await routedFixture();
    f.adapter.pending = true;
    await f.service.execute({ type: 'chat.ask', question: 'TEST QUESTION' });
    await f.service.execute({ type: 'tick' });
    await f.db.brain_requests.toCollection().modify({ deadline: 1, nextRetryAt: 0 });
    await f.service.execute({ type: 'tick' });
    let job = (await f.db.brain_requests.toArray())[0]!;
    expect(job.phase).toBe('paused');
    expect(job.receipt).toBeTruthy();
    expect(f.adapter.submitCalls).toBe(1);
    f.adapter.pending = false;
    await f.service.execute({ type: 'brain.resume', id: job.id });
    job = await drainRouting(f);
    expect(job.phase).toBe('done');
    expect(
      [...f.adapter.submissions.keys()].filter((key) => key.startsWith('brain:')),
    ).toHaveLength(1);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length) await cleanups.pop()!();
  });

  it('falls back to council discuss without a brain and does not post brain chat notices', async () => {
    const f = await fixture(2);
    cleanups.push(f.cleanup);
    for (const id of f.ids) await f.service.execute({ type: 'participant.check', id });
    f.adapter.answer = async () =>
      JSON.stringify(
        envelope({
          type: 'INITIAL_ANSWER',
          brief: 'fallback council brief for transport testing only.',
          content: 'TEST FIXTURE ONLY: fallback council answer.',
        }),
      );
    const result = await f.service.execute({ type: 'chat.ask', question: '请一起讨论这个问题' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { usedBrain: boolean; discussionId?: string; brief: string };
    expect(data.usedBrain).toBe(false);
    expect(data.discussionId).toBeTruthy();
    expect(data.brief).toContain('未指定大脑');
    const snap = await f.db.snapshot();
    expect(snap.chatNotices.some((n) => n.type === 'brain')).toBe(false);
    expect([...(snap.discussions[0]?.participantIds ?? [])].sort()).toEqual([...f.ids].sort());
  });

  it('routes direct_ask to one member and never includes the brain', async () => {
    const f = await fixture(2);
    cleanups.push(f.cleanup);
    const brain = await f.participants.updateProfile(f.ids[0]!, {
      role: 'brain',
      name: '路由大脑',
    });
    await f.participants.updateProfile(f.ids[1]!, { name: '熊大' });
    for (const id of f.ids) await f.service.execute({ type: 'participant.check', id });
    f.adapter.answer = async (task) => {
      if (isBrainDiscussion(task.discussionId)) {
        return JSON.stringify({
          intent: 'direct_ask',
          targets: ['熊大'],
          task: '去查一下规格',
          brief: '点名单办：交给熊大处理查询任务。',
          reason: '用户点名熊大',
        });
      }
      return JSON.stringify(
        envelope({
          type: 'INITIAL_ANSWER',
          brief: 'direct answer brief for transport testing only.',
          content: 'TEST FIXTURE ONLY: direct answer body.',
        }),
      );
    };
    const result = await f.service.execute({ type: 'chat.ask', question: '请安排熊大查询规格' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const queued = result.data as { intent: string; requestId?: string; usedBrain: boolean };
    expect(queued.usedBrain).toBe(true);
    expect(queued.intent).toBe('routing');
    expect(queued.requestId).toBeTruthy();
    const job = await finishBrainRoute(f);
    expect(job.phase).toBe('done');
    expect(job.route?.intent).toBe('direct_ask');
    expect(job.discussionId).toBeTruthy();
    const d = await f.db.discussions.get(job.discussionId!);
    expect(d?.mode).toBe('direct');
    expect(d?.originalQuestion).toBe('请安排熊大查询规格');
    expect(d?.context).toContain('去查一下规格');
    expect(d?.participantIds).toEqual([f.ids[1]]);
    expect(d?.participantIds).not.toContain(brain.id);
    await tick(f, 3);
    const after = await f.db.discussions.get(job.discussionId!);
    expect(after?.status).toBe('COMPLETED');
    const report = (await f.db.reports.toArray())[0]!;
    expect(report.markdown).toContain('未进行多成员共识判断');
    expect(report.markdown).not.toContain('确定性讨论共识规则已通过');
  });

  it('check_ready does not create a discussion', async () => {
    const f = await fixture(2);
    cleanups.push(f.cleanup);
    await f.participants.updateProfile(f.ids[0]!, { role: 'brain', name: '路由大脑' });
    for (const id of f.ids) await f.service.execute({ type: 'participant.check', id });
    f.adapter.answer = async () =>
      JSON.stringify({
        intent: 'check_ready',
        targets: [],
        task: '',
        brief: '先做就绪检查，不开启共识讨论。',
        reason: '用户问候是否准备好',
      });
    const before = (await f.db.discussions.toArray()).length;
    const result = await f.service.execute({ type: 'chat.ask', question: '你们在吗' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { intent: string }).intent).toBe('routing');
    const job = await finishBrainRoute(f);
    expect(job.phase).toBe('done');
    expect(job.route?.intent).toBe('check_ready');
    expect((await f.db.discussions.toArray()).length).toBe(before);
    const notices = await f.db.chat_notices.toArray();
    expect(notices.some((n) => n.type === 'readiness')).toBe(true);
  });

  it('rejects creating a discussion that includes the brain', async () => {
    const f = await fixture(2);
    cleanups.push(f.cleanup);
    await f.participants.updateProfile(f.ids[0]!, { role: 'brain' });
    await expect(
      f.create({
        participantIds: f.ids,
        mode: 'free',
      }),
    ).rejects.toThrow(/大脑/);
  });
});
