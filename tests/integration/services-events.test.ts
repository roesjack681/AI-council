import { afterEach, describe, it, expect } from 'vitest';
import { fixture, tick, agreeingResponse, envelope, type Fixture } from '../fixtures/council';
import { ReportGenerator } from '../../src/reports/report-generator';
import { TaskManager } from '../../src/core/task-manager';
import { recover } from '../../src/background/recovery';
let f: Fixture | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
describe('service boundary and event scheduling', () => {
  it('commands operate on the database, preserve audit, and reject deletion while in use', async () => {
    f = await fixture();
    const fx = f;
    await fx.service.initialize();
    expect((await fx.service.execute({ type: 'snapshot' })).ok).toBe(true);
    expect((await fx.service.execute({ type: 'participant.check', id: fx.ids[0] })).ok).toBe(true);
    expect((await fx.service.execute({ type: 'participant.open', id: fx.ids[0] })).ok).toBe(true);
    await fx.service.execute({ type: 'participant.enable', id: fx.ids[0], enabled: false });
    expect((await fx.db.participants.get(fx.ids[0]!))?.enabled).toBe(false);
    await fx.service.execute({ type: 'participant.enable', id: fx.ids[0], enabled: true });
    const d = await fx.create();
    expect((await fx.service.execute({ type: 'participant.remove', id: fx.ids[0] })).ok).toBe(
      false,
    );
    await fx.service.execute({ type: 'discussion.pause', id: d.id });
    expect((await fx.db.discussions.get(d.id))?.status).toBe('PAUSED');
    await fx.service.execute({ type: 'report.generate', id: d.id });
    expect(await fx.db.reports.count()).toBe(1);
    await fx.service.execute({ type: 'discussion.stop', id: d.id });
    await fx.service.execute({ type: 'participant.remove', id: fx.ids[0] });
    const report = await new ReportGenerator(fx.db).generate(d.id);
    expect(report.markdown).toContain('TEST MEMBER 0');
    await fx.service.execute({ type: 'discussion.delete', id: d.id });
    await fx.service.execute({ type: 'tick' });
    const kept = await fx.db.participants.count();
    await fx.service.execute({ type: 'data.clear', confirm: 'DELETE_LOCAL_DATA' });
    expect(await fx.db.participants.count()).toBe(kept);
    expect(await fx.db.discussions.count()).toBe(0);
  });
  it('event rounds target only objection stakeholders, not a hard-coded rotation or repeated requests', async () => {
    f = await fixture(3);
    const fx = f;
    const [author, target] = fx.ids;
    fx.adapter.answer = async (task) => {
      if (task.taskType === 'initial') return agreeingResponse(fx, task);
      if (task.taskType === 'review' && task.participantId === author) {
        const claim = (await fx.db.claims.toArray()).find((c) => c.ownerId === target)!;
        return JSON.stringify(
          envelope({
            objections: [
              {
                claimId: claim.id,
                title: 'TEST TARGETED EVENT',
                description: 'TEST SPECIFIC PROBLEM',
                severity: 'major',
                targetParticipantIds: [target!],
                evidence: [],
              },
            ],
          }),
        );
      }
      return JSON.stringify(envelope());
    };
    const d = await fx.create({ maxRounds: 5 });
    await fx.service.engine.start(d.id);
    await tick(fx, 55);
    const eventTasks = (await fx.db.task_queue.toArray()).filter((q) => q.taskType === 'event');
    expect(eventTasks).toHaveLength(2);
    expect(new Set(eventTasks.map((q) => q.participantId))).toEqual(new Set([author, target]));
  });
  it('an interrupted browser rechecks capabilities and persists recovery pause on logout', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    f.adapter.login = 'logged_out';
    await recover(f.db, f.service.gate);
    expect((await f.db.discussions.get(d.id))?.reason).toBe('LOGGED_OUT');
    expect((await f.db.logs.toArray()).some((l) => l.code === 'RECOVERY_PAUSED')).toBe(true);
  });
  it('a durable scheduler lease prevents two owners from dispatching the same queued operation', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    await f.db.leases.put({ id: 'scheduler', owner: 'other-worker', until: Date.now() + 30000 });
    await tick(f);
    expect(f.adapter.submitCalls).toBe(0);
    await f.db.leases.delete('scheduler');
    await Promise.all([f.service.scheduler.tick(), f.service.scheduler.tick()]);
    expect(f.adapter.submitCalls).toBe(1);
  });
  it('explicit resume reopens exhausted safe work while preserving its idempotency key', async () => {
    f = await fixture();
    f.adapter.safeFailures = 1;
    f.adapter.answer = (t) => agreeingResponse(f!, t);
    const d = await f.create({ maxRetries: 0 });
    await f.service.engine.start(d.id);
    await tick(f);
    const failed = (await f.db.task_queue.toArray()).find((q) => q.status === 'failed')!;
    expect(failed.lastError).toContain('SAFE_SEND_FAILED');
    await f.service.engine.start(d.id);
    await tick(f, 20);
    expect((await f.db.task_queue.get(failed.id))?.dedupeKey).toBe(failed.dedupeKey);
    expect((await f.db.discussions.get(d.id))?.status).toBe('COMPLETED');
  });
  it('nonterminal task data cannot be removed while discussion runs', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    await expect(new TaskManager(f.db).delete(d.id)).rejects.toThrow('请先停止或暂停任务');
  });
});
