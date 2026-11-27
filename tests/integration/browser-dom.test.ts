import { afterEach, describe, it, expect, vi } from 'vitest';
import { CouncilDB } from '../../src/database/db';
import { BrowserDomAdapter } from '../../src/adapters/dom/browser-dom-adapter';
import { domProfiles } from '../../src/adapters/dom/profiles';
import type { BrowserPort, BrowserTab } from '../../src/adapters/base/adapter.interface';
import type { PageObservation, PageRequest } from '../../src/adapters/dom/page-protocol';
import type { Participant, QueueTask } from '../../src/protocols/domain';
import { noCapabilities, isReady, canBeginFirstMessage } from '../../src/adapters/base/capability';
import { ComplianceGate } from '../../src/adapters/base/compliance-gate';
import { AdapterRegistry } from '../../src/adapters/registry';
import { CouncilError } from '../../src/utils/errors';
const observation = (): PageObservation => ({
  url: 'https://chat.deepseek.com/',
  editorFound: true,
  editorEmpty: true,
  outputCount: 1,
  userCount: 1,
  submitControlFound: true,
  completionControlFound: true,
  busy: false,
  login: 'logged_in',
  blocked: false,
  reason: '',
  markerFound: false,
  raw: '',
  outputId: '',
  dispatched: false,
});
class DOMTestBrowser implements BrowserPort {
  state = observation();
  requests: PageRequest[] = [];
  tabsList: BrowserTab[] = [{ id: 1, url: 'https://chat.deepseek.com/', status: 'complete' }];
  permission = true;
  submitAck = true;
  dispatched = true;
  creates = 0;
  async tabs() {
    return this.tabsList;
  }
  async open() {}
  async create(url: string) {
    this.creates++;
    this.state = { ...this.state, outputCount: 0, userCount: 0, completionControlFound: false };
    const tab: BrowserTab = { id: 100 + this.creates, url, status: 'complete' };
    this.tabsList.push(tab);
    return tab;
  }
  async page(_tabId: number, request: PageRequest) {
    if (!this.permission)
      throw new CouncilError('SITE_PERMISSION_REQUIRED', 'TEST PERMISSION MISSING');
    this.requests.push(request);
    if (request.operation === 'new_conversation') {
      const alreadyEmpty =
        this.state.editorFound &&
        this.state.editorEmpty &&
        !this.state.busy &&
        !this.state.blocked &&
        this.state.login === 'logged_in' &&
        this.state.outputCount === 0 &&
        this.state.userCount === 0;
      if (alreadyEmpty) return { ...this.state, newConversationState: 'empty' as const };
      this.state = {
        ...this.state,
        outputCount: 0,
        userCount: 0,
        completionControlFound: false,
        emptyConversation: true,
        editorEmpty: true,
        busy: false,
      };
      return {
        ...this.state,
        newConversationState: 'requested' as const,
        reason: '已点击新对话，等待网页进入空白会话；尚未发送问题',
      };
    }
    if (request.operation === 'submit') {
      this.state.markerFound = this.submitAck;
      return { ...this.state, dispatched: this.dispatched };
    }
    return { ...this.state };
  }
}
let db: CouncilDB | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (db) {
    db.close();
    await db.delete();
    db = undefined;
  }
});
async function setup() {
  db = new CouncilDB(`dom-adapter-${crypto.randomUUID()}`);
  await db.open();
  const browser = new DOMTestBrowser();
  const adapter = new BrowserDomAdapter(db, browser, domProfiles[0]!, {
    policy: 'restricted',
    reason: 'TEST RULE INFORMATION',
    sources: [],
  });
  const p: Participant = {
    id: 'p',
    name: 'TEST',
    avatar: '🤖',
    platform: 'deepseek',
    websiteUrl: 'https://chat.deepseek.com',
    enabled: true,
    role: 'council',
    adapterId: 'deepseek',
    adapterVersion: adapter.version,
    status: 'unsupported',
    capabilities: noCapabilities(),
    reason: '',
    createdAt: 1,
    updatedAt: 1,
  };
  const task: QueueTask = {
    id: 't',
    dedupeKey: 'key',
    discussionId: 'd',
    participantId: 'p',
    messageId: 'm',
    roundId: 'r',
    taskType: 'initial',
    status: 'pending',
    retryCount: 0,
    nextRetryAt: 0,
    leaseUntil: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  return { db, browser, adapter, p, task };
}
describe('browser DOM adapter (controlled transport, no real models)', () => {
  it('continues an exact task-owned draft before dispatch while preserving a foreign draft', async () => {
    const f = await setup();
    f.browser.state.editorEmpty = false;
    f.browser.state.draftMatchesRequest = true;
    f.browser.state.outputCount = 0;
    f.browser.state.userCount = 0;
    f.browser.state.completionControlFound = false;
    await f.adapter.submit(f.task, 'TEST', 'key');
    const check = f.browser.requests.find((request) => request.operation === 'inspect')!;
    expect(check.marker).toBe('[AI_COUNCIL_REQUEST:key]');
    expect(check.prompt).toContain('TEST\n\n[AI_COUNCIL_REQUEST:key]');
    expect(
      f.browser.requests.filter((request) => request.operation === 'new_conversation'),
    ).toHaveLength(0);
    expect(f.browser.requests.filter((request) => request.operation === 'submit')).toHaveLength(1);
    f.browser.state.draftMatchesRequest = false;
    await expect(
      f.adapter.submit({ ...f.task, participantId: 'other' }, 'TEST', 'another-key'),
    ).rejects.toMatchObject({ code: 'DRAFT_PRESENT' });
    expect(f.browser.requests.filter((request) => request.operation === 'submit')).toHaveLength(1);
  });
  it('bootstraps an observed blank Gemini home without requiring a previous-version read proof', async () => {
    const f = await setup();
    const profile = domProfiles.find((p) => p.id === 'gemini')!;
    const adapter = new BrowserDomAdapter(f.db, f.browser, profile, {
      policy: 'unverified',
      reason: 'TEST',
      sources: [],
    });
    const participant = {
      ...f.p,
      platform: 'gemini' as const,
      adapterId: 'gemini',
      websiteUrl: profile.newConversationUrl,
    };
    await f.db.participants.put(participant);
    f.browser.tabsList = [{ id: 1, url: profile.newConversationUrl, status: 'complete' }];
    Object.assign(f.browser.state, {
      url: profile.newConversationUrl,
      emptyConversation: true,
      outputCount: 0,
      userCount: 0,
      completionControlFound: false,
    });
    const gate = new ComplianceGate(f.db, new AdapterRegistry([adapter]), f.browser);
    expect(await gate.requireReady('p', 'initial', 'd')).toBe(adapter);
    const saved = (await f.db.participants.get('p'))!;
    expect(saved.status).toBe('first_message_ready');
    expect(saved.capabilities.canReadOutput).toBe(false);
    expect(saved.capabilities.canDetectCompletion).toBe(false);
    expect(saved.capabilities.unattendedAllowed).toBe(false);
    await expect(gate.requireReady('p')).rejects.toMatchObject({ code: 'FIRST_REPLY_PENDING' });
  });
  it('recreates a closed session only before any participant dispatch and persists an audit trail', async () => {
    const f = await setup();
    f.browser.tabsList = [];
    await f.db.browser_sessions.put({
      id: 'd:p',
      discussionId: 'd',
      participantId: 'p',
      tabId: 999,
      origin: 'https://chat.deepseek.com',
      createdAt: 1,
    });
    await f.adapter.submit(f.task, 'TEST', 'key');
    expect(f.browser.creates).toBe(1);
    expect((await f.db.browser_sessions.get('d:p'))?.tabId).toBe(101);
    expect(
      (await f.db.logs.toArray()).some((entry) => entry.code === 'UNSENT_SESSION_RECREATED'),
    ).toBe(true);
    expect(f.browser.requests.filter((request) => request.operation === 'submit')).toHaveLength(1);
    f.db.close();
    await f.db.open();
    await f.adapter.submit(f.task, 'TEST', 'key');
    expect(f.browser.creates).toBe(1);
    expect(f.browser.requests.filter((request) => request.operation === 'submit')).toHaveLength(1);
  });
  it.each(['prepared', 'submitted', 'complete'] as const)(
    'never replaces a closed session with an existing %s delivery, even for a different key',
    async (phase) => {
      const f = await setup();
      await f.adapter.submit(f.task, 'TEST', 'old-key');
      await f.db.browser_deliveries.update('old-key', { phase });
      const sessionTab = (await f.db.browser_sessions.get('d:p'))!.tabId;
      f.browser.tabsList = f.browser.tabsList.filter((tab) => tab.id !== sessionTab);
      await expect(f.adapter.submit(f.task, 'TEST', 'new-key')).rejects.toMatchObject({
        code: 'SESSION_TAB_CLOSED',
      });
      expect(f.browser.creates).toBe(1);
      expect(f.browser.requests.filter((request) => request.operation === 'submit')).toHaveLength(
        1,
      );
      expect(await f.db.browser_deliveries.get('new-key')).toBeUndefined();
    },
  );
  it('prepares each Gemini task independently without requiring or borrowing previous read proof', async () => {
    const f = await setup();
    const profile = domProfiles.find((p) => p.id === 'gemini')!;
    const adapter = new BrowserDomAdapter(f.db, f.browser, profile, {
      policy: 'unverified',
      reason: 'TEST',
      sources: [],
    });
    const participant = {
      ...f.p,
      platform: 'gemini' as const,
      adapterId: 'gemini',
      websiteUrl: profile.newConversationUrl,
      adapterVersion: adapter.version,
    };
    await f.db.participants.put(participant);
    f.browser.tabsList = [{ id: 1, url: profile.newConversationUrl, status: 'complete' }];
    Object.assign(f.browser.state, {
      url: profile.newConversationUrl,
      // Non-zero transcript so clean-home firstMessageAllowed stays false; only preparedAttempt applies.
      outputCount: 1,
      userCount: 1,
      completionControlFound: false,
      emptyConversation: false,
    });
    await f.db.browser_sessions.put({
      id: 'd:p',
      discussionId: 'd',
      participantId: 'p',
      tabId: 1,
      origin: profile.origins[0]!,
      createdAt: Date.now(),
      preparation: {
        phase: 'reset_requested',
        requestedAt: Date.now(),
        checkedAt: Date.now(),
        editorFound: true,
        editorEmpty: true,
        userCount: 1,
        outputCount: 1,
        reason: 'TEST reset requested',
        readProof: { adapterVersion: adapter.version, checkedAt: Date.now() },
      },
    });
    const gate = new ComplianceGate(f.db, new AdapterRegistry([adapter]), f.browser);
    expect((await gate.requireReady('p', 'initial', 'other-discussion')).id).toBe('gemini');
    expect((await f.db.browser_sessions.get('other-discussion:p'))?.tabId).not.toBe(1);
    await expect(gate.requireReady('p')).rejects.toMatchObject({ code: 'FIRST_REPLY_PENDING' });
    expect(await gate.requireReady('p', 'initial', 'd')).toBe(adapter);
    const check = (await f.db.participants.get('p'))!.check!;
    expect(check.technicalVerified).toBe(false);
    expect(check.capabilities.canDetectCompletion).toBe(false);
    expect(check.capabilities.unattendedAllowed).toBe(false);
    const session = (await f.db.browser_sessions.get('d:p'))!;
    session.preparation!.readProof!.adapterVersion = 'old';
    await f.db.browser_sessions.put(session);
    expect((await gate.requireReady('p', 'initial', 'd')).id).toBe('gemini');
    expect(f.browser.requests.some((r) => r.operation === 'submit')).toBe(false);
  });
  it('persists a delayed new-conversation request across reopening and never clicks or sends twice', async () => {
    const f = await setup();
    f.browser.tabsList = [];
    const create = f.browser.create.bind(f.browser);
    const page = f.browser.page.bind(f.browser);
    vi.spyOn(f.browser, 'create').mockImplementation(async (url) => {
      const tab = await create(url);
      Object.assign(f.browser.state, {
        outputCount: 1,
        userCount: 1,
        completionControlFound: true,
      });
      return tab;
    });
    vi.spyOn(f.browser, 'page').mockImplementation(async (tabId, request) => {
      const result = await page(tabId, request);
      if (request.operation !== 'new_conversation') return result;
      // Keep durable non-empty state so a worker restart still waits (does not send).
      Object.assign(f.browser.state, {
        outputCount: 1,
        userCount: 1,
        completionControlFound: true,
        emptyConversation: false,
      });
      return {
        ...f.browser.state,
        newConversationState: 'requested' as const,
        reason: 'TEST delayed new chat',
      };
    });
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'SESSION_INITIALIZING',
      safeToRetry: true,
    });
    expect(await f.db.browser_deliveries.count()).toBe(0);
    expect((await f.db.browser_sessions.toArray())[0]?.preparation?.phase).toBe('reset_requested');
    f.db.close();
    await f.db.open();
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'SESSION_INITIALIZING',
    });
    expect(f.browser.requests.filter((r) => r.operation === 'new_conversation')).toHaveLength(1);
    Object.assign(f.browser.state, { outputCount: 0, userCount: 0, completionControlFound: false });
    expect((await f.adapter.submit(f.task, 'TEST', 'key')).id).toBe('key');
    expect(f.browser.requests.filter((r) => r.operation === 'new_conversation')).toHaveLength(1);
    expect(f.browser.requests.filter((r) => r.operation === 'submit')).toHaveLength(1);
    expect((await f.db.browser_sessions.toArray())[0]?.preparation?.phase).toBe('ready');
  });
  it('bounds a stuck new-conversation transition without dispatching into history', async () => {
    const f = await setup();
    f.browser.tabsList = [];
    const create = f.browser.create.bind(f.browser);
    const page = f.browser.page.bind(f.browser);
    vi.spyOn(f.browser, 'create').mockImplementation(async (url) => {
      const tab = await create(url);
      f.browser.state.outputCount = 1;
      return tab;
    });
    vi.spyOn(f.browser, 'page').mockImplementation(async (tabId, request) => {
      const result = await page(tabId, request);
      if (request.operation !== 'new_conversation') return result;
      Object.assign(f.browser.state, {
        outputCount: 1,
        userCount: 1,
        emptyConversation: false,
      });
      return {
        ...f.browser.state,
        newConversationState: 'requested' as const,
      };
    });
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'SESSION_INITIALIZING',
    });
    const session = (await f.db.browser_sessions.toArray())[0]!;
    vi.spyOn(Date, 'now').mockReturnValue(session.preparation!.requestedAt! + 31_000);
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'SESSION_NOT_EMPTY',
      retryable: false,
      safeToRetry: true,
    });
    expect((await f.db.browser_sessions.get(session.id))?.preparation?.reason).toContain('30 秒');
    expect(f.browser.requests.some((r) => r.operation === 'submit')).toBe(false);
    expect(await f.db.browser_deliveries.count()).toBe(0);
  });
  it.each([
    { blocked: true, code: 'PAGE_CHALLENGE' },
    { login: 'logged_out' as const, code: 'LOGGED_OUT' },
    { editorEmpty: false, code: 'DRAFT_PRESENT' },
  ])('rechecks $code after clicking a new conversation', async ({ code, ...changes }) => {
    const f = await setup();
    f.browser.tabsList = [];
    const create = f.browser.create.bind(f.browser);
    const page = f.browser.page.bind(f.browser);
    vi.spyOn(f.browser, 'create').mockImplementation(async (url) => {
      const tab = await create(url);
      f.browser.state.outputCount = 1;
      return tab;
    });
    vi.spyOn(f.browser, 'page').mockImplementation(async (tabId, request) => {
      const result = await page(tabId, request);
      return request.operation === 'new_conversation'
        ? {
            ...result,
            outputCount: 0,
            userCount: 0,
            newConversationState: 'empty' as const,
            ...changes,
          }
        : result;
    });
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({ code });
    expect(f.browser.requests.some((r) => r.operation === 'submit')).toBe(false);
    expect(await f.db.browser_deliveries.count()).toBe(0);
  });
  it('allows only an initial attempt on a proven blank DeepSeek page without claiming verified reading', async () => {
    const f = await setup();
    Object.assign(f.browser.state, {
      emptyConversation: true,
      outputCount: 0,
      userCount: 0,
      completionControlFound: false,
    });
    await f.db.participants.put(f.p);
    const gate = new ComplianceGate(f.db, new AdapterRegistry([f.adapter]), f.browser);
    const check = await gate.inspect(f.p.id);
    expect(check.failureCode).toBe('FIRST_REPLY_PENDING');
    expect(check.firstMessageAllowed).toBe(true);
    expect(check.technicalVerified).toBe(false);
    expect(check.capabilities.canReadOutput).toBe(false);
    expect(check.capabilities.canDetectCompletion).toBe(false);
    expect(check.capabilities.unattendedAllowed).toBe(false);
    expect(isReady(check, f.adapter.version)).toBe(false);
    expect(canBeginFirstMessage(check, f.adapter.version)).toBe(true);
    expect((await f.db.participants.get(f.p.id))?.status).toBe('first_message_ready');
    await expect(gate.requireReady(f.p.id)).rejects.toMatchObject({ code: 'FIRST_REPLY_PENDING' });
    expect(await gate.requireReady(f.p.id, 'initial')).toBe(f.adapter);
    expect(f.browser.requests.some((r) => r.operation === 'submit')).toBe(false);
    for (const altered of [
      { ...check, checkedAt: Date.now() - 130_000 },
      { ...check, checkedAt: Date.now() + 1000 },
      { ...check, interactionMode: 'metadata_only' as const },
      { ...check, login: 'logged_out' as const },
      { ...check, firstMessageAllowed: false },
    ])
      expect(canBeginFirstMessage(altered, f.adapter.version)).toBe(false);
    expect(canBeginFirstMessage(check, 'other-version')).toBe(false);
  });
  it('does not infer a blank page from failed selectors or from contradictory observations', async () => {
    const f = await setup();
    // Old chat URL with zero matched transcript must not bootstrap a first attempt.
    Object.assign(f.browser.state, {
      url: 'https://chat.deepseek.com/a/chat/old',
      outputCount: 0,
      userCount: 0,
      completionControlFound: false,
      emptyConversation: false,
    });
    expect((await f.adapter.inspect(f.p, f.browser)).firstMessageAllowed).toBe(false);
    for (const override of [
      { busy: true },
      { blocked: true },
      { editorEmpty: false },
      { userCount: 1 },
      { login: 'logged_out' as const },
    ]) {
      f.browser.state = {
        ...observation(),
        outputCount: 0,
        userCount: 0,
        completionControlFound: false,
        emptyConversation: true,
        ...override,
      };
      expect((await f.adapter.inspect(f.p, f.browser)).firstMessageAllowed).toBe(false);
    }
  });
  it('names a missing editor accurately and saves tab diagnostics', async () => {
    const f = await setup();
    f.browser.state.editorFound = false;
    f.browser.state.submitControlFound = false;
    f.browser.state.outputCount = 0;
    f.browser.state.login = 'unknown';
    const result = await f.adapter.inspect(f.p, f.browser);
    expect(result.failureCode).toBe('EDITOR_NOT_FOUND');
    expect(result.reasons[0]).toContain('未匹配到');
    expect(result.reasons[0]).not.toContain('输入框已找到');
    expect(result.diagnostics?.[0]?.editorFound).toBe(false);
  });
  it('distinguishes missing output, missing completion, busy page and missing permission', async () => {
    const f = await setup();
    f.browser.state.outputCount = 0;
    expect((await f.adapter.inspect(f.p, f.browser)).failureCode).toBe('OUTPUT_NOT_FOUND');
    f.browser.state.outputCount = 1;
    f.browser.state.completionControlFound = false;
    expect((await f.adapter.inspect(f.p, f.browser)).failureCode).toBe('COMPLETION_NOT_FOUND');
    f.browser.state.busy = true;
    expect((await f.adapter.inspect(f.p, f.browser)).failureCode).toBe('PAGE_BUSY');
    f.browser.permission = false;
    const check = await f.adapter.inspect(f.p, f.browser);
    expect(check.failureCode).toBe('SITE_PERMISSION_REQUIRED');
    expect(check.diagnostics?.[0]?.errorCode).toBe('SITE_PERMISSION_REQUIRED');
  });
  it('does not send into an old conversation restored in a newly created tab', async () => {
    const f = await setup();
    f.browser.tabsList = [];
    const create = f.browser.create.bind(f.browser);
    const page = f.browser.page.bind(f.browser);
    vi.spyOn(f.browser, 'create').mockImplementation(async (url) => {
      const tab = await create(url);
      f.browser.state.outputCount = 1;
      f.browser.state.userCount = 1;
      return tab;
    });
    vi.spyOn(f.browser, 'page').mockImplementation(async (tabId, request) => {
      const result = await page(tabId, request);
      if (request.operation !== 'new_conversation') return result;
      return {
        ...result,
        outputCount: 1,
        userCount: 1,
        newConversationState: 'not_found' as const,
        reason: '新标签页恢复了旧对话，未找到新对话按钮；没有发送',
      };
    });
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'SESSION_NOT_EMPTY',
      safeToRetry: true,
    });
    expect(f.browser.requests.some((r) => r.operation === 'submit')).toBe(false);
  });
  it('uses actual page readiness instead of a policy blanket ban', async () => {
    const f = await setup();
    const check = await f.adapter.inspect(f.p, f.browser);
    expect(check.policy).toBe('restricted');
    expect(check.interactionMode).toBe('browser_dom');
    expect(isReady(check, f.adapter.version)).toBe(true);
  });
  it('requires website permission and a completed response sample', async () => {
    const f = await setup();
    f.browser.permission = false;
    expect((await f.adapter.inspect(f.p, f.browser)).reasons.join()).toContain('检查能力');
    f.browser.permission = true;
    f.browser.state.outputCount = 0;
    expect((await f.adapter.inspect(f.p, f.browser)).capabilities.unattendedAllowed).toBe(false);
  });
  it('reports logout, challenge and missing pages honestly', async () => {
    const f = await setup();
    f.browser.state.login = 'logged_out';
    expect((await f.adapter.inspect(f.p, f.browser)).login).toBe('logged_out');
    f.browser.state.login = 'logged_in';
    f.browser.state.blocked = true;
    expect((await f.adapter.inspect(f.p, f.browser)).technicalVerified).toBe(false);
    f.browser.tabsList = [];
    expect((await f.adapter.inspect(f.p, f.browser)).pageOpen).toBe(false);
  });
  it('creates one isolated session and persists marker before dispatch; repeat does not resend', async () => {
    const f = await setup();
    const receipt = await f.adapter.submit(f.task, 'TEST PROMPT', 'key');
    expect(receipt.id).toBe('key');
    expect(f.browser.creates).toBe(1);
    expect((await f.db.browser_sessions.get('d:p'))?.tabId).toBe(101);
    expect((await f.db.browser_deliveries.get('key'))?.phase).toBe('submitted');
    expect(f.browser.requests.find((r) => r.operation === 'submit')?.prompt).toContain(
      '[AI_COUNCIL_REQUEST:key]',
    );
    await f.adapter.submit(f.task, 'TEST PROMPT', 'key');
    expect(f.browser.requests.filter((r) => r.operation === 'submit')).toHaveLength(1);
  });
  it('does not reuse a tab still owned by an unfinished discussion', async () => {
    const f = await setup();
    await f.adapter.submit(f.task, 'TEST', 'key-d1');
    expect(f.browser.creates).toBe(1);
    const tabId = (await f.db.browser_sessions.get('d:p'))!.tabId;
    Object.assign(f.browser.state, {
      outputCount: 0,
      userCount: 0,
      completionControlFound: false,
      emptyConversation: true,
      editorEmpty: true,
    });
    const next = {
      ...f.task,
      id: 't2',
      discussionId: 'd2',
      dedupeKey: 'key-d2',
      messageId: 'm2',
    };
    await f.adapter.submit(next, 'TEST NEXT', 'key-d2');
    expect(f.browser.creates).toBe(2);
    expect((await f.db.browser_sessions.get('d2:p'))?.tabId).not.toBe(tabId);
    expect((await f.db.logs.toArray()).some((entry) => entry.code === 'SESSION_TAB_REUSED')).toBe(
      false,
    );
  });
  it('reuses a completed task tab only after every delivery on it has completed', async () => {
    const f = await setup();
    await f.adapter.submit(f.task, 'TEST', 'key-d1');
    const tabId = (await f.db.browser_sessions.get('d:p'))!.tabId;
    await f.db.discussions.put({
      id: 'd',
      title: 'TEST',
      originalQuestion: 'TEST',
      context: '',
      constraints: [],
      expectedOutput: '',
      mode: 'free',
      participantIds: ['p', 'other'],
      maxRounds: 10,
      stableRoundsRequired: 2,
      timeoutMs: 1000,
      maxRetries: 2,
      privacyAcknowledged: true,
      currentRound: 2,
      noProgressRounds: 0,
      lastProgressFingerprint: '',
      status: 'COMPLETED',
      createdAt: 1,
      updatedAt: 1,
    });
    await f.db.browser_deliveries.update('key-d1', { phase: 'complete' });
    Object.assign(f.browser.state, {
      outputCount: 0,
      userCount: 0,
      completionControlFound: false,
      emptyConversation: true,
      editorEmpty: true,
    });
    await f.adapter.submit(
      { ...f.task, id: 't2', discussionId: 'd2', dedupeKey: 'key-d2', messageId: 'm2' },
      'TEST NEXT',
      'key-d2',
    );
    expect(f.browser.creates).toBe(1);
    expect((await f.db.browser_sessions.get('d2:p'))?.tabId).toBe(tabId);
  });
  it('keeps unowned personal platform tabs separate from a new task', async () => {
    const f = await setup();
    // setup leaves tab 1 open at deepseek with no browser_session yet
    expect(f.browser.tabsList).toHaveLength(1);
    await f.adapter.submit(f.task, 'TEST', 'key-claim');
    expect(f.browser.creates).toBe(1);
    expect((await f.db.browser_sessions.get('d:p'))?.tabId).toBe(101);
    expect((await f.db.logs.toArray()).some((entry) => entry.code === 'SESSION_TAB_CLAIMED')).toBe(
      false,
    );
  });
  it('allows ChatGPT blank home as an initial attempt without requiring a prior reply sample', async () => {
    const f = await setup();
    const profile = domProfiles.find((p) => p.id === 'chatgpt')!;
    const adapter = new BrowserDomAdapter(f.db, f.browser, profile, {
      policy: 'restricted',
      reason: 'TEST',
      sources: [],
    });
    const participant = {
      ...f.p,
      platform: 'chatgpt' as const,
      adapterId: 'chatgpt',
      websiteUrl: profile.newConversationUrl,
      adapterVersion: adapter.version,
    };
    await f.db.participants.put(participant);
    f.browser.tabsList = [{ id: 1, url: profile.newConversationUrl, status: 'complete' }];
    Object.assign(f.browser.state, {
      url: profile.newConversationUrl,
      emptyConversation: true,
      outputCount: 0,
      userCount: 0,
      completionControlFound: false,
    });
    const gate = new ComplianceGate(f.db, new AdapterRegistry([adapter]), f.browser);
    expect(await gate.requireReady('p', 'initial', 'd')).toBe(adapter);
    expect((await f.db.participants.get('p'))?.status).toBe('first_message_ready');
    await expect(gate.requireReady('p')).rejects.toMatchObject({ code: 'FIRST_REPLY_PENDING' });
  });
  it('does not overwrite drafts and does not call submit on a busy editor', async () => {
    const f = await setup();
    f.browser.state.editorEmpty = false;
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'DRAFT_PRESENT',
      safeToRetry: true,
    });
    expect(await f.db.browser_deliveries.count()).toBe(0);
    f.browser.state.editorEmpty = true;
    f.browser.state.busy = true;
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'PAGE_BUSY',
      safeToRetry: true,
    });
  });
  it('does not clear unmatched drafts merely because they resemble AI Council text', async () => {
    const f = await setup();
    Object.assign(f.browser.state, { editorEmpty: false, draftMatchesRequest: false });
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'DRAFT_PRESENT',
    });
    expect(f.browser.requests.some((r) => r.operation === 'submit')).toBe(false);
  });
  it('durable prepared state survives lost acknowledgements and resumes without replay', async () => {
    const f = await setup();
    f.browser.submitAck = false;
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      code: 'DELIVERY_UNKNOWN',
    });
    expect((await f.db.browser_deliveries.get('key'))?.phase).toBe('prepared');
    expect((await f.adapter.reconcile(f.task, 'key')).state).toBe('unknown');
    f.browser.state.markerFound = true;
    expect((await f.adapter.reconcile(f.task, 'key')).state).toBe('submitted');
    expect(f.browser.requests.filter((r) => r.operation === 'submit')).toHaveLength(1);
  });
  it('can prove no dispatch when no prepared record exists', async () => {
    const f = await setup();
    expect((await f.adapter.reconcile(f.task, 'never-dispatched')).state).toBe('not_sent');
  });
  it('a rejected pre-dispatch operation is safe and leaves no delivery record', async () => {
    const f = await setup();
    f.browser.dispatched = false;
    f.browser.submitAck = false;
    await expect(f.adapter.submit(f.task, 'TEST', 'key')).rejects.toMatchObject({
      safeToRetry: true,
    });
    expect(await f.db.browser_deliveries.count()).toBe(0);
  });
  it('waits for explicit completion controls, no stop button, and stable output before receiving', async () => {
    const f = await setup();
    const receipt = await f.adapter.submit(f.task, 'TEST', 'key');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.browser.state.raw = 'TEST FIXTURE RESPONSE';
    f.browser.state.busy = true;
    expect((await f.adapter.poll(f.task, receipt)).state).toBe('pending');
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    f.browser.state.busy = false;
    f.browser.state.completionControlFound = false;
    expect((await f.adapter.poll(f.task, receipt)).state).toBe('pending');
    f.browser.state.completionControlFound = true;
    const result = await f.adapter.poll(f.task, receipt);
    expect(result.state).toBe('complete');
    expect((await f.db.browser_deliveries.get('key'))?.raw).toBe('TEST FIXTURE RESPONSE');
    f.browser.tabsList = [];
    expect((await f.adapter.cachedResponse(f.task, receipt))?.raw).toBe('TEST FIXTURE RESPONSE');
    await expect(
      f.adapter.cachedResponse({ ...f.task, discussionId: 'other' }, receipt),
    ).rejects.toMatchObject({ code: 'CROSS_TASK_RECEIPT' });
    expect((await f.adapter.poll(f.task, receipt)).state).toBe('complete');
  });
  it('never reads another conversation when the request marker disappears or tab closes', async () => {
    const f = await setup();
    const receipt = await f.adapter.submit(f.task, 'TEST', 'key');
    f.browser.state.markerFound = false;
    await expect(f.adapter.poll(f.task, receipt)).rejects.toMatchObject({
      code: 'MESSAGE_NOT_FOUND',
    });
    const sessionTab = (await f.db.browser_sessions.get('d:p'))!.tabId;
    f.browser.tabsList = f.browser.tabsList.filter((t) => t.id !== sessionTab);
    await expect(f.adapter.poll(f.task, receipt)).rejects.toMatchObject({
      code: 'SESSION_TAB_CLOSED',
    });
  });
  it('refuses a receipt belonging to another task', async () => {
    const f = await setup();
    const receipt = await f.adapter.submit(f.task, 'TEST', 'key');
    await expect(
      f.adapter.poll({ ...f.task, discussionId: 'other' }, receipt),
    ).rejects.toMatchObject({ code: 'CROSS_TASK_RECEIPT' });
  });
});
