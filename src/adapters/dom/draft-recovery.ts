import type { CouncilDB } from '../../database/db';
import type { BrowserSession, RecoveredDraft } from '../../protocols/domain';
import type { BrowserPort } from '../base/adapter.interface';
import type { PageObservation, PageProfile } from './page-protocol';
import { legacyDraftMarker, normalizeDraft, webPrompt } from './request-wire';
import { digest } from '../../utils/id';
import { CouncilError, requireValue } from '../../utils/errors';
import { log } from '../../utils/logger';
import { TaskManager, terminal } from '../../core/task-manager';
import { RequestCoordinator } from '../../core/request-coordinator';

/** Only moves complete app requests out of a task-owned editor, after durable reversible backup. */
export class DraftRecovery {
  constructor(
    private readonly db: CouncilDB,
    private readonly browser: BrowserPort,
    private readonly profile: PageProfile,
  ) {}
  async moveStale(
    session: BrowserSession,
    observation: PageObservation,
    currentMarker?: string,
  ): Promise<PageObservation> {
    const content = observation.draftText;
    if (
      !content ||
      observation.editorEmpty ||
      observation.draftMatchesRequest ||
      observation.blocked ||
      observation.busy ||
      content.length > 210_000
    )
      return observation;
    const markers = content.match(/\[AI_COUNCIL_REQUEST:([a-f0-9]{64})\]/g) ?? [];
    if (markers.length !== 1 || markers[0] === currentMarker) return observation;
    const marker = markers[0]!,
      key = marker.slice('[AI_COUNCIL_REQUEST:'.length, -1);
    const message = await this.db.messages.where('dedupeKey').equals(key).first();
    const brain = (await this.db.brain_requests.toArray()).find(
      (job) => job.task.dedupeKey === key,
    );
    const known =
      message?.direction === 'outbound' &&
      normalizeDraft(webPrompt(message.content, key)) === normalizeDraft(content)
        ? { discussionId: message.discussionId, reason: 'saved_request' as const }
        : brain && normalizeDraft(webPrompt(brain.prompt, key)) === normalizeDraft(content)
          ? { discussionId: brain.task.discussionId, reason: 'saved_request' as const }
          : undefined;
    if (!known && legacyDraftMarker(content) !== marker) return observation;
    const owner = await this.db.browser_sessions.get(session.id);
    if (!owner || owner.tabId !== session.tabId || owner.discussionId !== session.discussionId)
      throw new CouncilError('SESSION_CHANGED', '专用会话归属已变化，未移动草稿');
    const task = await this.db.discussions.get(session.discussionId);
    if (task && !(await new RequestCoordinator(this.db).isCurrent(task.userRequestId)))
      throw new CouncilError('REQUEST_SUPERSEDED', '旧任务不能修改当前页面草稿');
    const contentDigest = await digest(normalizeDraft(content));
    const id = await digest(JSON.stringify([session.id, contentDigest]));
    await this.db.transaction('rw', this.db.tables, async () => {
      const prior = await this.db.recovered_drafts.get(id);
      if ((prior?.attempts ?? 0) >= 3)
        throw new CouncilError('DRAFT_PRESENT', '旧草稿已保留，但网站反复恢复输入，已停止自动修改');
      const now = Date.now();
      await this.db.recovered_drafts.put({
        id,
        discussionId: session.discussionId,
        participantId: session.participantId,
        tabId: session.tabId,
        origin: session.origin,
        url: observation.url,
        marker,
        content,
        digest: contentDigest,
        reason: known?.reason ?? 'legacy_envelope',
        phase: 'saved',
        attempts: (prior?.attempts ?? 0) + 1,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      if (known && known.discussionId !== session.discussionId) {
        const old = await this.db.discussions.get(known.discussionId);
        if (old && !terminal(old.status) && old.status !== 'PAUSED')
          await new TaskManager(this.db).pause(old.id, 'STALE_DRAFT_RETIRED');
        if (brain && !['done', 'cancelled', 'paused'].includes(brain.phase))
          await this.db.brain_requests.update(brain.id, {
            resumePhase:
              brain.phase === 'pending' ||
              brain.phase === 'sending' ||
              brain.phase === 'waiting' ||
              brain.phase === 'routing'
                ? brain.phase
                : brain.resumePhase,
            phase: 'paused',
            error: { code: 'STALE_DRAFT_RETIRED', detail: '遗留草稿已保留，旧请求不会自动继续。' },
            updatedAt: now,
          });
      }
      await log(this.db, 'info', 'STALE_DRAFT_SAVED', id, session.discussionId);
    });
    // Compare again in the page immediately before mutation. No send button/Enter is used here.
    const result = await requireValue(this.browser.page, '网页操作不可用').call(
      this.browser,
      session.tabId,
      { operation: 'clear_draft', profile: this.profile, marker, prompt: content },
    );
    const cleared = result.draftState === 'cleared' && result.editorEmpty;
    await this.db.recovered_drafts.update(id, {
      phase: cleared ? 'cleared' : 'changed',
      updatedAt: Date.now(),
    });
    await log(
      this.db,
      cleared ? 'info' : 'warn',
      cleared ? 'STALE_DRAFT_MOVED' : 'DRAFT_CHANGED',
      id,
      session.discussionId,
    );
    if (!cleared)
      throw new CouncilError(
        'DRAFT_PRESENT',
        '草稿已保留；网页内容发生变化或未接受清空，未发送旧内容',
      );
    return result;
  }
  async restore(record: RecoveredDraft): Promise<void> {
    const sessions = await this.db.browser_sessions
      .filter((s) => s.tabId === record.tabId)
      .toArray();
    for (const session of sessions) {
      const d = await this.db.discussions.get(session.discussionId);
      if (d && !terminal(d.status) && !['PAUSED', 'CREATED'].includes(d.status))
        throw new CouncilError('TASK_ACTIVE', '任务仍在运行，不能恢复旧草稿');
    }
    if (
      (await this.db.browser_deliveries
        .filter((d) => d.tabId === record.tabId && d.phase !== 'complete')
        .count()) > 0
    )
      throw new CouncilError('DELIVERY_UNKNOWN', '该标签仍有未完成交付，不能恢复草稿');
    if (
      (await this.db.brain_requests.toArray()).some(
        (job) =>
          !['paused', 'done', 'cancelled'].includes(job.phase) &&
          sessions.some((s) => s.discussionId === job.task.discussionId),
      )
    )
      throw new CouncilError('TASK_ACTIVE', '该标签仍有运行中的路由，不能恢复草稿');
    const result = await requireValue(this.browser.page, '网页操作不可用').call(
      this.browser,
      record.tabId,
      {
        operation: 'restore_draft',
        profile: this.profile,
        marker: record.marker,
        prompt: record.content,
        expectedUrl: record.url,
      },
    );
    if (result.draftState !== 'restored')
      throw new CouncilError(
        'DRAFT_PRESENT',
        '输入框不为空、页面状态改变或无法写入；原文仍保存在本地',
      );
    await this.db.recovered_drafts.update(record.id, { phase: 'restored', updatedAt: Date.now() });
    await log(this.db, 'info', 'DRAFT_RESTORED_WITHOUT_SEND', record.id, record.discussionId);
  }
}
