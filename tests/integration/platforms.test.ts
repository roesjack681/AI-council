import { afterEach, describe, it, expect } from 'vitest';
import { CouncilDB } from '../../src/database/db';
import { AdapterRegistry, platformCatalog } from '../../src/adapters/registry';
import { ParticipantService } from '../../src/services/participant-service';
import { ComplianceGate } from '../../src/adapters/base/compliance-gate';
import { DiscussionEngine } from '../../src/core/discussion-engine';
import { TaskManager } from '../../src/core/task-manager';
import { isReady } from '../../src/adapters/base/capability';
import { trustedSender, commandSchema } from '../../src/protocols/commands';
import { browser, TestAdapter } from '../fixtures/council';
let db: CouncilDB | undefined;
afterEach(async () => {
  if (db) {
    db.close();
    await db.delete();
    db = undefined;
  }
});
describe('platform compliance and configuration', () => {
  it.each(platformCatalog)(
    'T13 metadata-only $name never fabricates browser capability from open tabs or forged flags',
    async (platform) => {
      db = new CouncilDB(`platform-${crypto.randomUUID()}`);
      const registry = new AdapterRegistry();
      const svc = new ParticipantService(db, registry, browser);
      const p = await svc.add({
        name: platform.name,
        platform: platform.id,
        websiteUrl: platform.url,
        enabled: true,
      });
      const gate = new ComplianceGate(db, registry, {
        ...browser,
        async tabs() {
          return [{ id: 1, url: platform.url, status: 'complete' }];
        },
      });
      await db.participants.update(p.id, {
        capabilities: {
          canReadOutput: true,
          canSubmitMessage: true,
          canDetectCompletion: true,
          canDetectLogin: true,
          canCaptureUserQuestion: true,
          unattendedAllowed: true,
        },
      });
      const check = await gate.inspect(p.id);
      expect(check.pageOpen).toBe(true);
      expect(check.login).toBe('unknown');
      await expect(gate.requireReady(p.id)).rejects.toThrow();
      expect((await db.participants.get(p.id))?.capabilities.unattendedAllowed).toBe(false);
      await expect(registry.get(p.adapterId).submit({} as never, 'test', 'key')).rejects.toThrow();
    },
  );
  it('restricted participants persist a paused task with no invented messages', async () => {
    db = new CouncilDB(`platform-${crypto.randomUUID()}`);
    const registry = new AdapterRegistry();
    const svc = new ParticipantService(db, registry, browser);
    const ids = [];
    for (const p of platformCatalog.slice(0, 2))
      ids.push(
        (await svc.add({ name: p.name, platform: p.id, websiteUrl: p.url, enabled: true })).id,
      );
    const d = await new TaskManager(db).create({
      title: 'test',
      originalQuestion: 'test',
      context: '',
      constraints: [],
      expectedOutput: '',
      participantIds: ids,
      maxRounds: 10,
      stableRoundsRequired: 2,
      timeoutMs: 1000,
      maxRetries: 2,
      privacyAcknowledged: true,
    });
    await new DiscussionEngine(db, new ComplianceGate(db, registry, browser)).start(d.id);
    expect((await db.discussions.get(d.id))?.status).toBe('PAUSED');
    expect(await db.messages.count()).toBe(0);
  });
  it('unsafe URL, platform origin mismatch and capability config injection are rejected', async () => {
    db = new CouncilDB(`platform-${crypto.randomUUID()}`);
    const service = new ParticipantService(db, new AdapterRegistry(), browser);
    for (const websiteUrl of [
      'http://chat.deepseek.com',
      'https://chat.deepseek.com.evil.test',
      'https://a:b@chat.deepseek.com',
      'https://chat.deepseek.com?token=secret',
    ])
      await expect(
        service.add({ name: 'TEST', platform: 'deepseek', websiteUrl, enabled: true }),
      ).rejects.toThrow();
    expect(
      commandSchema.safeParse({
        type: 'participant.add',
        input: {
          name: 'TEST',
          platform: 'custom',
          websiteUrl: 'https://test.example',
          enabled: true,
          capabilities: { unattendedAllowed: true },
        },
      }).success,
    ).toBe(false);
  });
  it('stale, future or technically unverified checks cannot authorize interaction', async () => {
    const adapter = new TestAdapter();
    const check = await adapter.inspect();
    expect(isReady(check, adapter.version)).toBe(true);
    for (const altered of [
      { ...check, checkedAt: Date.now() - 130000 },
      { ...check, checkedAt: Date.now() + 1000 },
      { ...check, technicalVerified: false },
      { ...check, login: 'unknown' as const },
      { ...check, pageReachable: 'unknown' as const },
    ])
      expect(isReady(altered, adapter.version)).toBe(false);
  });
  it('runtime commands require own sidepanel sender and reject unknown fields', () => {
    expect(trustedSender({ id: 'own', url: 'chrome-extension://own/sidepanel.html' }, 'own')).toBe(
      true,
    );
    expect(trustedSender({ id: 'other', url: 'https://example.com' }, 'own')).toBe(false);
    expect(
      trustedSender(
        { id: 'own', url: 'https://external.example', tab: { id: 1 } as chrome.tabs.Tab },
        'own',
      ),
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        type: 'discussion.start',
        id: 'd',
        originalQuestion: 'replacement',
      }).success,
    ).toBe(false);
  });
});
