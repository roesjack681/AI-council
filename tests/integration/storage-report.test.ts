import { afterEach, describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import { CouncilDB } from '../../src/database/db';
import { ReportGenerator } from '../../src/reports/report-generator';
import { fixture, type Fixture } from '../fixtures/council';
let f: Fixture | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
describe('storage, migrations and exports', () => {
  it('upgrade from v1 preserves task context and initializes recovery fields', async () => {
    const name = `migration-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({ discussions: 'id,status,updatedAt' });
    await legacy
      .table('discussions')
      .add({ id: 'd', originalQuestion: 'TEST ORIGINAL', status: 'CREATED', updatedAt: 1 });
    legacy.close();
    const db = new CouncilDB(name);
    try {
      await db.open();
      expect((await db.discussions.get('d'))?.originalQuestion).toBe('TEST ORIGINAL');
      expect((await db.discussions.get('d'))?.noProgressRounds).toBe(0);
      expect(db.verno).toBe(7);
    } finally {
      db.close();
      await db.delete();
    }
  });
  it('reopening IndexedDB restores persisted tasks and reports; HTML escapes injected markup', async () => {
    f = await fixture();
    const d = await f.create({
      originalQuestion: '<script>globalThis.stolen=true</script>',
      title: '<img src=x onerror=alert(1)>',
    });
    const report = await new ReportGenerator(f.db).generate(d.id);
    expect(report.html).not.toContain('<script>');
    expect(report.html).not.toContain('<img');
    expect(report.html).toContain('&lt;script&gt;');
    expect(report.markdown).toContain('无已记录内容');
    f.db.close();
    await f.db.open();
    expect((await f.db.discussions.get(d.id))?.status).toBe('CREATED');
    expect((await f.db.reports.toArray())[0]?.json).toBe(report.json);
  });
  it('local wipe clears discussion data but keeps participant configuration', async () => {
    f = await fixture();
    const d = await f.create();
    await f.service.engine.start(d.id);
    await new ReportGenerator(f.db).generate(d.id);
    const kept = await f.db.participants.count();
    expect(kept).toBeGreaterThan(0);
    await f.db.clearLocalData();
    expect(await f.db.participants.count()).toBe(kept);
    for (const table of f.db.tables) {
      if (table.name === 'participants') continue;
      expect(await table.count()).toBe(0);
    }
  });
  it('command failures are returned and audited; caller cannot declare completion', async () => {
    f = await fixture();
    const result = await f.service.execute({ type: 'discussion.complete', id: 'forged' });
    expect(result.ok).toBe(false);
    expect((await f.db.logs.toArray()).some((l) => l.code === 'COMMAND_FAILED')).toBe(true);
  });
});
