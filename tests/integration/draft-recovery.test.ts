import { afterEach, describe, expect, it, vi } from 'vitest';
import { CouncilDB } from '../../src/database/db';
import { CouncilService } from '../../src/services/council-service';
import { ParticipantService } from '../../src/services/participant-service';
import { AdapterRegistry } from '../../src/adapters/registry';
import type { BrowserPort, BrowserTab } from '../../src/adapters/base/adapter.interface';
import type { PageObservation, PageRequest } from '../../src/adapters/dom/page-protocol';
import { legacyDraft, oldRequestKey } from '../fixtures/legacy-draft';
import { legacyDraftMarker, webPrompt } from '../../src/adapters/dom/request-wire';
import { TaskManager } from '../../src/core/task-manager';
import { DraftRecovery } from '../../src/adapters/dom/draft-recovery';
import { domProfiles } from '../../src/adapters/dom/profiles';

class DraftBrowser implements BrowserPort {
  tabsList: BrowserTab[] = [];
  draft = legacyDraft;
  sent: string[] = [];
  cleared = 0;
  changeOnClear = false;
  constructor(private readonly db: CouncilDB) {}
  async tabs() {
    return this.tabsList;
  }
  async open() {}
  async create(url: string) {
    const tab: BrowserTab = { id: 1, url, status: 'complete' };
    this.tabsList = [tab];
    return tab;
  }
  async page(_tab: number, request: PageRequest): Promise<PageObservation> {
    if (request.operation === 'clear_draft') {
      const copies = await this.db.recovered_drafts.toArray();
      expect(copies.some((copy) => copy.content === request.prompt && copy.phase === 'saved')).toBe(
        true,
      );
      if (this.changeOnClear) this.draft = 'TEST NEW USER EDIT';
      if (this.draft === request.prompt) {
        this.draft = '';
        this.cleared++;
      } else return { ...this.observe(request), draftState: 'changed' };
      return { ...this.observe(request), draftState: 'cleared' };
    }
    if (request.operation === 'restore_draft') {
      if (this.draft) return { ...this.observe(request), draftState: 'changed' };
      this.draft = request.prompt!;
      return { ...this.observe(request), draftState: 'restored' };
    }
    if (request.operation === 'submit') {
      this.sent.push(request.prompt!);
      this.draft = '';
    }
    return this.observe(request);
  }
  private observe(request: PageRequest): PageObservation {
    return {
      url: 'https://chatgpt.com/',
      editorFound: true,
      editorEmpty: !this.draft,
      draftMatchesRequest: !!request.prompt && request.prompt === this.draft,
      ...(request.captureDraft ? { draftText: this.draft } : {}),
      outputCount: 0,
      userCount: 0,
      submitControlFound: true,
      completionControlFound: false,
      busy: false,
      login: 'logged_in',
      blocked: false,
      reason: '',
      markerFound: this.sent.length > 0,
      raw: '',
      outputId: '',
      dispatched: request.operation === 'submit',
    };
  }
}
describe('stale app drafts are backed up before removal, never sent as the current question', () => {
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
    db = new CouncilDB(`draft-recovery-${crypto.randomUUID()}`);
    await db.open();
    const browser = new DraftBrowser(db),
      registry = new AdapterRegistry(undefined, { db, browser });
    const service = new CouncilService(db, browser, registry);
    await new ParticipantService(db, registry, browser).add({
      name: '光头强',
      platform: 'chatgpt',
      websiteUrl: 'https://chatgpt.com/',
      enabled: true,
    });
    return { db, browser, service, registry };
  }
  it('moves the historical math envelope out of the editor before sending only the new greeting', async () => {
    const f = await setup();
    expect((await f.service.execute({ type: 'chat.ask', question: '光头强在吗' })).ok).toBe(true);
    expect(f.browser.cleared).toBe(1);
    expect(f.browser.sent).toHaveLength(1);
    expect(f.browser.sent[0]).toMatch(/^光头强在吗\n/);
    expect(f.browser.sent[0]).not.toContain('1+1');
    const copy = (await f.db.recovered_drafts.toArray())[0]!;
    expect(copy.content).toBe(legacyDraft);
    expect(copy.phase).toBe('cleared');
    expect(copy.reason).toBe('legacy_envelope');
    f.db.close();
    await f.db.open();
    expect((await f.db.snapshot()).recoveredDrafts?.[0]?.content).toBe(legacyDraft);
  });
  it.each([
    'TEST USER DRAFT',
    `请检查这段引用：\n${legacyDraft}`,
    legacyDraft + '\nTEST USER ADDITION',
  ])('preserves a normal or edited/quoted draft: %s', async (draft) => {
    const f = await setup();
    f.browser.draft = draft;
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(f.browser.draft).toBe(draft);
    expect(f.browser.sent).toHaveLength(0);
    expect(await f.db.recovered_drafts.count()).toBe(0);
    expect((await f.db.discussions.toArray())[0]?.reason).toBe('DRAFT_PRESENT');
  });
  it('does not clear anything if the durable backup fails', async () => {
    const f = await setup();
    vi.spyOn(f.db.recovered_drafts, 'put').mockRejectedValue(new Error('TEST DISK FAILURE'));
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(f.browser.cleared).toBe(0);
    expect(f.browser.draft).toBe(legacyDraft);
    expect(f.browser.sent).toHaveLength(0);
  });
  it('backs up the captured draft but protects edits made before the page-side comparison', async () => {
    const f = await setup();
    f.browser.changeOnClear = true;
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(f.browser.draft).toBe('TEST NEW USER EDIT');
    expect(f.browser.sent).toHaveLength(0);
    expect((await f.db.recovered_drafts.toArray())[0]?.phase).toBe('changed');
  });
  it('recovers only the latest DRAFT_PRESENT task on startup; never starts another old task', async () => {
    const f = await setup();
    f.browser.draft = 'TEST ORDINARY DRAFT';
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    const d = (await f.db.discussions.toArray())[0]!;
    expect(d.status).toBe('PAUSED');
    f.browser.draft = legacyDraft;
    const restarted = new CouncilService(f.db, f.browser, f.registry);
    await restarted.initialize();
    expect((await f.db.discussions.get(d.id))?.status).toBe('INITIALIZING');
    expect(f.browser.sent).toHaveLength(0);
    await restarted.execute({ type: 'tick' });
    expect(f.browser.sent).toHaveLength(1);
    expect(f.browser.sent[0]).toMatch(/^光头强在吗\n/);
  });
  it('explicit restore writes an empty editor without sending and refuses overwrite', async () => {
    const f = await setup();
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    const copy = (await f.db.recovered_drafts.toArray())[0]!;
    expect((await f.service.execute({ type: 'draft.restore', id: copy.id })).ok).toBe(false);
    await f.db.discussions.update(copy.discussionId, { status: 'COMPLETED' });
    await f.db.browser_deliveries.toCollection().modify({ phase: 'complete' });
    f.browser.draft = 'TEST KEEP THIS';
    expect((await f.service.execute({ type: 'draft.restore', id: copy.id })).ok).toBe(false);
    expect(f.browser.draft).toBe('TEST KEEP THIS');
    f.browser.draft = '';
    expect((await f.service.execute({ type: 'draft.restore', id: copy.id })).ok).toBe(true);
    expect(f.browser.draft).toBe(legacyDraft);
    expect(f.browser.sent).toHaveLength(1);
  });
  it('recognizes only the full historical envelope, not a marker or a keyword', () => {
    expect(legacyDraftMarker(legacyDraft)).toContain('AI_COUNCIL_REQUEST');
    expect(legacyDraftMarker('AI Council')).toBeUndefined();
    expect(legacyDraftMarker(legacyDraft.replace('claims:', 'other:'))).toBeUndefined();
  });
  it('can identify a saved old plain request by full content without using the legacy format fallback', async () => {
    const f = await setup();
    const participant = (await f.db.participants.toArray())[0]!;
    const old = await new TaskManager(f.db).create({
      title: 'OLD',
      originalQuestion: 'TEST OLD WORDS',
      context: '',
      constraints: [],
      expectedOutput: '',
      participantIds: [participant.id],
      mode: 'direct',
      maxRounds: 2,
      stableRoundsRequired: 1,
      timeoutMs: 1000,
      maxRetries: 2,
      privacyAcknowledged: true,
    });
    await f.db.discussions.update(old.id, { status: 'INITIAL_ANSWERS' });
    await f.db.messages.add({
      id: 'old-message',
      dedupeKey: oldRequestKey,
      discussionId: old.id,
      participantId: participant.id,
      roundId: 'old-round',
      direction: 'outbound',
      type: 'INITIAL_ANSWER',
      content: 'TEST OLD WORDS',
      parseStatus: 'not_applicable',
      relatedClaimIds: [],
      relatedObjectionIds: [],
      status: 'pending',
      createdAt: 1,
    });
    f.browser.draft = webPrompt('TEST OLD WORDS', oldRequestKey);
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect((await f.db.recovered_drafts.toArray())[0]?.reason).toBe('saved_request');
    expect((await f.db.discussions.get(old.id))?.status).toBe('PAUSED');
    expect(f.browser.sent).toHaveLength(1);
    expect(f.browser.sent[0]).not.toContain('TEST OLD WORDS');
  });
  it('does not auto-resume a task that the user explicitly paused', async () => {
    const f = await setup();
    f.browser.draft = 'TEST KEEP';
    await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    const d = (await f.db.discussions.toArray())[0]!;
    await f.db.discussions.update(d.id, { reason: 'USER_PAUSED' });
    f.browser.draft = legacyDraft;
    await new CouncilService(f.db, f.browser, f.registry).initialize();
    expect(await f.db.recovered_drafts.count()).toBe(0);
    expect(f.browser.cleared).toBe(0);
    expect((await f.db.discussions.get(d.id))?.status).toBe('PAUSED');
  });
  it('retiring an old brain draft preserves its waiting phase and original delivery receipt', async () => {
    const f = await setup(),
      p = (await f.db.participants.toArray())[0]!;
    const d = await new TaskManager(f.db).create({
      title: 'TEST',
      originalQuestion: 'CURRENT',
      context: '',
      constraints: [],
      expectedOutput: '',
      participantIds: [p.id],
      mode: 'direct',
      maxRounds: 2,
      stableRoundsRequired: 1,
      timeoutMs: 1000,
      maxRetries: 2,
      privacyAcknowledged: true,
    });
    await f.db.brain_requests.put({
      id: 'old-brain',
      participantId: p.id,
      question: 'OLD',
      prompt: 'TEST OLD BRAIN REQUEST',
      verificationPolicy: 'discussion_only',
      task: {
        id: 'brain-task',
        dedupeKey: oldRequestKey,
        discussionId: '__brain__:old',
        participantId: p.id,
        messageId: 'brain-message',
        roundId: 'brain-round',
        taskType: 'initial',
        status: 'waiting',
        receiptId: 'old-receipt',
        retryCount: 0,
        nextRetryAt: 0,
        leaseUntil: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      phase: 'waiting',
      receipt: { id: 'old-receipt', submittedAt: 1 },
      noticeIds: [],
      repairCount: 0,
      retryCount: 0,
      confirmationAttempts: 0,
      nextRetryAt: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const tab = await f.browser.create('https://chatgpt.com/');
    const session = {
      id: `${d.id}:${p.id}`,
      discussionId: d.id,
      participantId: p.id,
      tabId: tab.id,
      origin: 'https://chatgpt.com',
      createdAt: Date.now(),
    };
    await f.db.browser_sessions.put(session);
    f.browser.draft = webPrompt('TEST OLD BRAIN REQUEST', oldRequestKey);
    const profile = domProfiles.find((profile) => profile.id === 'chatgpt')!;
    await new DraftRecovery(f.db, f.browser, profile).moveStale(
      session,
      await f.browser.page(tab.id, { operation: 'inspect', captureDraft: true, profile }),
    );
    const old = (await f.db.brain_requests.get('old-brain'))!;
    expect(old.phase).toBe('paused');
    expect(old.resumePhase).toBe('waiting');
    expect(old.receipt?.id).toBe('old-receipt');
  });
});
