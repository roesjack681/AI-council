import { afterEach, describe, it, expect } from 'vitest';
import { fixture, tick, agreeingResponse, envelope, type Fixture } from '../fixtures/council';
import { TaskManager } from '../../src/core/task-manager';
import { ReportGenerator } from '../../src/reports/report-generator';
import { recover } from '../../src/background/recovery';
let f: Fixture | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
describe('persisted discussion lifecycle (test transport only)', () => {
  it('a failed resume persists actionable detail while preserving the original resume status', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    await new TaskManager(f.db).pause(d.id, 'OLD_ERROR', 'old detail');
    const previous = (await f.db.discussions.get(d.id))?.resumeStatus;
    f.adapter.allowed = false;
    await expect(f.service.engine.start(d.id)).rejects.toThrow('TEST MEMBER');
    const blocked = await f.db.discussions.get(d.id);
    expect(blocked?.status).toBe('PAUSED');
    expect(blocked?.resumeStatus).toBe(previous);
    expect(blocked?.reasonDetail).toContain('TEST MEMBER');
    f.adapter.allowed = true;
    await f.service.engine.start(d.id);
    expect((await f.db.discussions.get(d.id))?.reasonDetail).toBeUndefined();
  });
  it('independent answers → review → two final rounds → actual persisted report', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.answer = (t) => agreeingResponse(fx, t);
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    await tick(fx, 30);
    const done = await fx.db.discussions.get(d.id);
    expect(done?.status).toBe('COMPLETED');
    expect(await fx.db.messages.count()).toBe(12);
    expect(await fx.db.reports.count()).toBe(1);
    const report = (await fx.db.reports.toArray())[0]!;
    expect(report.status).toBe('COMPLETED');
    expect(JSON.parse(report.json).discussion.originalQuestion).toBe(d.originalQuestion);
    expect(fx.adapter.submissions.size).toBe(6);
    const initial = (await fx.db.messages.toArray()).filter(
      (m) => m.direction === 'outbound' && m.type === 'INITIAL_ANSWER',
    );
    for (const message of initial)
      expect(message.content).toContain(`本次你的参与者 ID：${message.participantId}`);
    expect(initial[0]?.content.replace(/本次你的参与者 ID：[^\n]+\n/, '')).toBe(
      initial[1]?.content.replace(/本次你的参与者 ID：[^\n]+\n/, ''),
    );
    expect(initial[0]?.content).not.toContain('TEST PROPOSAL');
  });
  it('T09 recovers waiting work without repeating a successful send', async () => {
    f = await fixture();
    f.adapter.answer = (t) => agreeingResponse(f!, t);
    const d = await f.create();
    await f.service.engine.start(d.id);
    await tick(f);
    const before = f.adapter.submitCalls;
    await recover(f.db, f.service.gate);
    await tick(f);
    expect(f.adapter.submitCalls).toBe(before);
    expect((await f.db.task_queue.toArray()).some((q) => q.status === 'done')).toBe(true);
  });
  it('T10 stops at max rounds, never fabricates agreement', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.answer = async (t) => {
      if (t.taskType === 'initial') return agreeingResponse(fx, t);
      const claims = await fx.db.claims.toArray();
      return JSON.stringify(
        envelope({
          positions: claims.map((c) => ({
            claimId: c.id,
            version: c.version,
            position: 'DISAGREE',
            reason: 'TEST specific disagreement with proposal',
            final: true,
            conditions: [],
          })),
        }),
      );
    };
    const d = await fx.create({ maxRounds: 2 });
    await fx.service.engine.start(d.id);
    await tick(fx, 35);
    expect((await fx.db.discussions.get(d.id))?.reason).toBe('MAX_ROUNDS');
    expect((await fx.db.discussions.get(d.id))?.status).toBe('UNRESOLVED');
  });
  it('stops after three consecutive rounds without semantic progress', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.answer = async (t) =>
      t.taskType === 'initial' ? agreeingResponse(fx, t) : JSON.stringify(envelope());
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    await tick(fx, 55);
    expect((await fx.db.discussions.get(d.id))?.reason).toBe('STALLED');
  });
  it('T14 isolates two concurrent tasks and all report content', async () => {
    f = await fixture();
    const fx = f;
    fx.adapter.answer = (t) => agreeingResponse(fx, t);
    const a = await fx.create({ title: 'ONLY TASK A', originalQuestion: 'QUESTION A' });
    const b = await fx.create({ title: 'ONLY TASK B', originalQuestion: 'QUESTION B' });
    await fx.service.engine.start(a.id);
    await fx.service.engine.start(b.id);
    await tick(fx, 65);
    expect((await fx.db.discussions.get(a.id))?.status).toBe('COMPLETED');
    expect((await fx.db.discussions.get(b.id))?.status).toBe('COMPLETED');
    const report = await new ReportGenerator(fx.db).generate(a.id);
    expect(report.json).not.toContain('QUESTION B');
    expect(
      JSON.parse(report.json).messages.every(
        (m: { discussionId: string }) => m.discussionId === a.id,
      ),
    ).toBe(true);
  });
  it('pause, resume and stop preserve immutable original context', async () => {
    f = await fixture();
    const d = await f.create();
    const tm = new TaskManager(f.db);
    await tm.pause(d.id);
    await tm.resume(d.id);
    await tm.stop(d.id);
    expect((await f.db.discussions.get(d.id))?.originalQuestion).toBe('TEST ORIGINAL QUESTION');
    await expect(tm.transition(d.id, 'COMPLETED')).rejects.toThrow();
  });
  it('delete cascades task records and preserves unrelated participants', async () => {
    f = await fixture();
    const fx = f;
    const d = await fx.create();
    await fx.service.engine.start(d.id);
    await new TaskManager(fx.db).pause(d.id);
    await new ReportGenerator(fx.db).generate(d.id);
    await new TaskManager(fx.db).delete(d.id);
    expect(await fx.db.messages.count()).toBe(0);
    expect(await fx.db.task_queue.count()).toBe(0);
    expect(await fx.db.reports.count()).toBe(0);
    expect(await fx.db.participants.count()).toBe(2);
  });
  it('malformed natural-language replies are retained and repaired only twice', async () => {
    f = await fixture();
    f.adapter.answer = async () =>
      'TEST NATURAL LANGUAGE: cannot parse this as a structured protocol';
    const d = await f.create();
    await f.service.engine.start(d.id);
    await tick(f, 35);
    expect((await f.db.discussions.get(d.id))?.reason).toBe('PARSE_FAILED');
    const messages = await f.db.messages.toArray();
    expect(
      messages.some(
        (m) => m.content.startsWith('TEST NATURAL') && m.parseStatus === 'PARSE_FAILED',
      ),
    ).toBe(true);
    expect(f.adapter.submitCalls).toBeLessThanOrEqual(6);
  });
});
