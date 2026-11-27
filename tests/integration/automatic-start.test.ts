import { afterEach, describe, expect, it } from 'vitest';
import { CouncilDB } from '../../src/database/db';
import { CouncilService } from '../../src/services/council-service';
import { AdapterRegistry } from '../../src/adapters/registry';
import { ParticipantService } from '../../src/services/participant-service';
import { domProfiles } from '../../src/adapters/dom/profiles';
import type { BrowserPort, BrowserTab } from '../../src/adapters/base/adapter.interface';
import type { PageObservation, PageRequest } from '../../src/adapters/dom/page-protocol';
import { CouncilError } from '../../src/utils/errors';
import { TaskManager } from '../../src/core/task-manager';

class StartupBrowser implements BrowserPort {
  records = new Map<number, PageObservation>();
  requests: { tabId: number; operation: PageRequest['operation']; prompt?: string }[] = [];
  tabList: BrowserTab[] = [];
  creates = 0;
  loading = false;
  permission = true;
  restoreUnknownChat = false;
  keepOldPathAfterReset = false;
  async tabs() {
    return this.tabList;
  }
  async open() {}
  async create(url: string) {
    if (!this.permission)
      throw new CouncilError('SITE_PERMISSION_REQUIRED', 'TEST missing permission');
    const tab = { id: ++this.creates, url, status: 'complete' as const };
    this.tabList.push(tab);
    this.records.set(tab.id, {
      url: this.restoreUnknownChat ? `${new URL(url).origin}/unknown-old-chat` : url,
      editorFound: true,
      editorEmpty: true,
      outputCount: 0,
      userCount: 0,
      submitControlFound: true,
      completionControlFound: false,
      busy: false,
      login: 'logged_in',
      blocked: false,
      reason: '',
      markerFound: false,
      raw: '',
      outputId: '',
      dispatched: false,
    });
    return tab;
  }
  async page(tabId: number, request: PageRequest) {
    this.requests.push({ tabId, operation: request.operation, prompt: request.prompt });
    const state = this.records.get(tabId)!;
    if (this.loading) return { ...state, editorFound: false, login: 'unknown' as const };
    if (request.operation === 'new_conversation') {
      Object.assign(state, {
        url: this.keepOldPathAfterReset ? state.url : request.profile.newConversationUrl,
        emptyConversation: !this.keepOldPathAfterReset,
        outputCount: 0,
        userCount: 0,
        completionControlFound: false,
      });
      return { ...state, newConversationState: 'requested' as const };
    }
    if (request.operation === 'submit')
      Object.assign(state, {
        userCount: 1,
        markerFound: true,
        outputCount: 1,
        completionControlFound: true,
        raw: 'TEST FIXTURE ONLY: natural answer',
        dispatched: true,
      });
    return { ...state };
  }
}

describe('automatic website startup without prior answers or manual checks', () => {
  let db: CouncilDB | undefined;
  afterEach(async () => {
    if (db) {
      db.close();
      await db.delete();
      db = undefined;
    }
  });
  async function setup(platform = 'chatgpt', role: 'brain' | 'council' = 'council') {
    db = new CouncilDB(`auto-start-${crypto.randomUUID()}`);
    await db.open();
    const browser = new StartupBrowser();
    const registry = new AdapterRegistry(undefined, { db, browser });
    const service = new CouncilService(db, browser, registry);
    const profile = domProfiles.find((profile) => profile.id === platform)!;
    const participant = await new ParticipantService(db, registry, browser).add({
      name: '光头强',
      platform,
      role,
      websiteUrl: profile.newConversationUrl,
      enabled: true,
    });
    return { db, browser, service, registry, participant };
  }
  it.each(domProfiles.map((profile) => profile.id))(
    'opens %s and sends the first question with no sample or participant.check command',
    async (platform) => {
      const f = await setup(platform);
      expect((await f.service.execute({ type: 'chat.ask', question: '光头强在吗' })).ok).toBe(true);
      expect(f.browser.creates).toBe(1);
      const sent = f.browser.requests.filter((request) => request.operation === 'submit');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.prompt).toMatch(/^光头强在吗\n\n\[AI_COUNCIL_REQUEST:/);
      const check = (await f.db.participants.get(f.participant.id))!.check!;
      expect(check.firstMessageAllowed).toBe(true);
      expect(check.capabilities.canReadOutput).toBe(false);
      expect(check.capabilities.canDetectCompletion).toBe(false);
      expect(check.capabilities.unattendedAllowed).toBe(false);
      expect(await f.db.messages.filter((message) => message.direction === 'inbound').count()).toBe(
        0,
      );
    },
  );
  it('persists loading state, survives restart, and starts automatically once the page loads', async () => {
    const f = await setup();
    f.browser.loading = true;
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    const d = (await f.db.discussions.toArray())[0]!;
    expect(d.status).toBe('INITIALIZING');
    expect(d.startup?.attempts).toBe(1);
    expect(await f.db.task_queue.count()).toBe(0);
    const restarted = new CouncilService(f.db, f.browser, f.registry);
    await restarted.initialize();
    expect((await f.db.discussions.get(d.id))?.status).toBe('INITIALIZING');
    f.browser.loading = false;
    await f.db.discussions.update(d.id, { startup: { ...d.startup!, nextCheckAt: 0 } });
    await restarted.execute({ type: 'tick' });
    expect(f.browser.creates).toBe(1);
    expect(f.browser.requests.filter((r) => r.operation === 'submit')).toHaveLength(1);
  });
  it('automatically creates a fresh chat if a dedicated tab restores an unidentified old conversation', async () => {
    const f = await setup();
    f.browser.restoreUnknownChat = true;
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(f.browser.requests.filter((r) => r.operation === 'new_conversation')).toHaveLength(1);
    expect(f.browser.requests.filter((r) => r.operation === 'submit')).toHaveLength(1);
  });
  it('bounds page loading and pauses with records, without ever sending or fabricating a response', async () => {
    const f = await setup();
    f.browser.loading = true;
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    const d = (await f.db.discussions.toArray())[0]!;
    await f.db.discussions.update(d.id, {
      startup: { ...d.startup!, nextCheckAt: 0, deadline: 1 },
    });
    await f.service.execute({ type: 'tick' });
    expect((await f.db.discussions.get(d.id))?.status).toBe('PAUSED');
    expect((await f.db.discussions.get(d.id))?.reason).toBe('PAGE_LOADING');
    expect(await f.db.messages.count()).toBe(0);
  });
  it('recognizes a proven transcript reset when the SPA keeps its old URL without clicking twice', async () => {
    const f = await setup();
    f.browser.restoreUnknownChat = true;
    f.browser.keepOldPathAfterReset = true;
    const create = f.browser.create.bind(f.browser);
    f.browser.create = async (url) => {
      const tab = await create(url);
      Object.assign(f.browser.records.get(tab.id)!, {
        userCount: 1,
        outputCount: 1,
        completionControlFound: true,
      });
      return tab;
    };
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(f.browser.requests.filter((r) => r.operation === 'new_conversation')).toHaveLength(1);
    expect(f.browser.requests.filter((r) => r.operation === 'submit')).toHaveLength(1);
  });
  it('does not navigate or send before Chrome grants website access', async () => {
    const f = await setup();
    f.browser.permission = false;
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(f.browser.creates).toBe(0);
    expect((await f.db.discussions.toArray())[0]?.reason).toBe('SITE_PERMISSION_REQUIRED');
    expect(f.browser.requests).toHaveLength(0);
  });
  it('keeps a pending queue alive while its page reloads and sends once after recovery', async () => {
    const f = await setup();
    const d = await new TaskManager(f.db).create({
      title: 'TEST',
      originalQuestion: '光头强在吗',
      context: '',
      constraints: [],
      expectedOutput: '',
      participantIds: [f.participant.id],
      mode: 'direct',
      maxRounds: 2,
      stableRoundsRequired: 1,
      timeoutMs: 180_000,
      maxRetries: 2,
      privacyAcknowledged: true,
    });
    await f.service.engine.start(d.id);
    f.browser.loading = true;
    await f.service.scheduler.tick();
    let task = (await f.db.task_queue.toArray())[0]!;
    expect(task.status).toBe('pending');
    expect(task.retryCount).toBe(0);
    expect(task.preflightDeadline).toBeGreaterThan(Date.now());
    const restarted = new CouncilService(f.db, f.browser, f.registry);
    await restarted.initialize();
    expect((await f.db.discussions.get(d.id))?.status).toBe('INITIAL_ANSWERS');
    f.browser.loading = false;
    await f.db.task_queue.update(task.id, { nextRetryAt: 0 });
    await restarted.execute({ type: 'tick' });
    task = (await f.db.task_queue.get(task.id))!;
    expect(task.status).toBe('waiting');
    expect(f.browser.requests.filter((r) => r.operation === 'submit')).toHaveLength(1);
  });
  it('the brain also automatically waits for its page instead of immediately pausing', async () => {
    const f = await setup('deepseek', 'brain');
    f.browser.loading = true;
    await f.service.execute({ type: 'chat.ask', question: '请安排成员处理新问题' });
    await f.service.execute({ type: 'tick' });
    let job = (await f.db.brain_requests.toArray())[0]!;
    expect(job.phase).toBe('pending');
    expect(job.task.preflightDeadline).toBeGreaterThan(Date.now());
    f.browser.loading = false;
    await f.db.brain_requests.update(job.id, { nextRetryAt: 0 });
    await f.service.execute({ type: 'tick' });
    job = (await f.db.brain_requests.toArray())[0]!;
    expect(job.phase).toBe('waiting');
    expect(f.browser.creates).toBe(1);
  });
});
