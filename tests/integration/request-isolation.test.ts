import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { fixture, browser, tick, type Fixture } from '../fixtures/council';
import { CouncilService } from '../../src/services/council-service';
import { CouncilDB } from '../../src/database/db';
import { RequestCoordinator } from '../../src/core/request-coordinator';

describe('current question isolation and natural direct replies', () => {
  it('an old task without request ownership cannot send while a new foreground request exists', async () => {
    f = await fixture();
    const old = await f.create();
    await f.service.engine.start(old.id);
    await new RequestCoordinator(f.db).begin();
    await f.db.discussions.update(old.id, { status: 'INITIAL_ANSWERS', userRequestId: undefined });
    await tick(f, 2);
    expect(f.adapter.submitCalls).toBe(0);
    expect((await f.db.discussions.get(old.id))?.reason).toBe('REQUEST_SUPERSEDED');
  });
  let f: Fixture | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await f?.cleanup();
    f = undefined;
  });

  it('sends 光头强在吗 verbatim, pauses queued old math, and preserves that isolation after restart', async () => {
    f = await fixture(2);
    await f.participants.updateProfile(f.ids[0]!, { name: '光头强' });
    const old = await f.create({ originalQuestion: '你俩说说1+1等于几' });
    await f.service.engine.start(old.id); // Queue only: no model has received this old question.
    const oldQueue = await f.db.task_queue.where('discussionId').equals(old.id).toArray();
    const send = vi.spyOn(f.adapter, 'submit');
    f.adapter.answer = async () => 'TEST NATURAL REPLY: 在，收到本次消息。';
    const result = await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = (result.data as { discussionId: string }).discussionId;
    expect((await f.db.discussions.get(old.id))?.reason).toBe('NEW_QUESTION');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toBe('光头强在吗');
    expect(send.mock.calls[0]?.[0].discussionId).toBe(id);
    const restarted = new CouncilService(f.db, browser, f.registry);
    await restarted.initialize();
    for (let n = 0; n < 5; n++) {
      await f.db.task_queue.where('discussionId').equals(id).modify({ nextRetryAt: 0 });
      await restarted.execute({ type: 'tick' });
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect((await f.db.discussions.get(id))?.status).toBe('COMPLETED');
    expect(await f.db.task_queue.where('discussionId').equals(old.id).toArray()).toEqual(oldQueue);
    const incoming = await f.db.messages
      .filter((m) => m.discussionId === id && m.direction === 'inbound')
      .first();
    expect(incoming?.parseStatus).toBe('not_applicable');
    expect(incoming?.content).toContain('TEST NATURAL REPLY');
    expect(incoming?.structuredData).toBeUndefined();
    expect(await f.db.claims.where('discussionId').equals(id).count()).toBe(0);
    expect((await f.db.reports.where('discussionId').equals(id).first())?.markdown).toContain(
      'TEST NATURAL REPLY',
    );
    expect((await restarted.execute({ type: 'discussion.start', id: old.id })).ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].discussionId).toBe(old.id);
  });

  it('a new direct question supersedes an unfinished router without sending its old request', async () => {
    f = await fixture(2);
    await f.participants.updateProfile(f.ids[0]!, { role: 'brain' });
    await f.participants.updateProfile(f.ids[1]!, { name: '光头强' });
    await f.service.execute({ type: 'chat.ask', question: '你俩说说1+1等于几' });
    const old = (await f.db.brain_requests.toArray())[0]!;
    f.adapter.answer = async () => 'TEST NATURAL DIRECT REPLY';
    const send = vi.spyOn(f.adapter, 'submit');
    expect((await f.service.execute({ type: 'chat.ask', question: '光头强在吗' })).ok).toBe(true);
    await tick(f, 5);
    expect((await f.db.brain_requests.get(old.id))?.error?.code).toBe('NEW_QUESTION');
    expect(
      send.mock.calls.every(
        ([task, prompt]) => task.participantId === f!.ids[1] && prompt === '光头强在吗',
      ),
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a stale managed discussion cannot regain sending authority by mutating its status', async () => {
    f = await fixture();
    const d = await f.create();
    const coordinator = new RequestCoordinator(f.db);
    await coordinator.activateDiscussion(d.id);
    await f.service.engine.start(d.id);
    await coordinator.begin();
    await f.db.discussions.update(d.id, { status: 'INITIAL_ANSWERS' });
    await tick(f, 2);
    expect(f.adapter.submitCalls).toBe(0);
    expect((await f.db.discussions.get(d.id))?.reason).toBe('REQUEST_SUPERSEDED');
    const restarted = new CouncilService(f.db, browser, f.registry);
    await f.db.discussions.update(d.id, { status: 'INITIAL_ANSWERS' });
    await restarted.initialize();
    expect((await f.db.discussions.get(d.id))?.reason).toBe('REQUEST_SUPERSEDED');
  });

  it('invalid resume commands do not pause the current valid question', async () => {
    f = await fixture(1);
    await f.participants.updateProfile(f.ids[0]!, { name: '光头强' });
    const result = await f.service.execute({ type: 'chat.ask', question: '光头强在吗' });
    expect(result.ok).toBe(true);
    const current = await f.db.runtime_state.get('foreground');
    expect((await f.service.execute({ type: 'discussion.start', id: 'missing' })).ok).toBe(false);
    expect((await f.service.execute({ type: 'brain.resume', id: 'missing' })).ok).toBe(false);
    expect(await f.db.runtime_state.get('foreground')).toEqual(current);
    expect((await f.db.discussions.get(current!.discussionId!))?.status).toBe('INITIAL_ANSWERS');
  });

  it('upgrading v5 pauses unfinished work and preserves uncertain delivery receipts', async () => {
    const name = `legacy-v5-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(5).stores({
      discussions: 'id,status,updatedAt',
      brain_requests: 'id,phase',
      task_queue: 'id,discussionId',
      messages: 'id',
    });
    await legacy
      .table('discussions')
      .put({ id: 'old', status: 'INITIAL_ANSWERS', originalQuestion: 'OLD MATH', updatedAt: 1 });
    await legacy
      .table('brain_requests')
      .put({ id: 'brain', phase: 'waiting', receipt: { id: 'receipt:brain' } });
    await legacy
      .table('task_queue')
      .put({ id: 'queue', discussionId: 'old', status: 'sending', receiptId: 'receipt:old' });
    await legacy
      .table('messages')
      .put({ id: 'message', content: 'OLD UNSENT OR UNCERTAIN PROMPT' });
    legacy.close();
    const upgraded = new CouncilDB(name);
    try {
      await upgraded.open();
      expect((await upgraded.discussions.get('old'))?.reason).toBe('UPGRADE_REVIEW_REQUIRED');
      expect((await upgraded.discussions.get('old'))?.resumeStatus).toBe('INITIAL_ANSWERS');
      expect((await upgraded.brain_requests.get('brain'))?.phase).toBe('paused');
      expect((await upgraded.brain_requests.get('brain'))?.receipt?.id).toBe('receipt:brain');
      expect((await upgraded.task_queue.get('queue'))?.status).toBe('sending');
      expect((await upgraded.task_queue.get('queue'))?.receiptId).toBe('receipt:old');
      expect((await upgraded.messages.get('message'))?.content).toBe(
        'OLD UNSENT OR UNCERTAIN PROMPT',
      );
    } finally {
      upgraded.close();
      await upgraded.delete();
    }
  });
});
