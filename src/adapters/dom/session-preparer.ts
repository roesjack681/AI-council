import type { CouncilDB } from '../../database/db';
import type { BrowserSession } from '../../protocols/domain';
import type { BrowserPort } from '../base/adapter.interface';
import type { PageObservation, PageProfile } from './page-protocol';
import { CouncilError, requireValue } from '../../utils/errors';
import { log } from '../../utils/logger';

export const SESSION_PREPARATION_TIMEOUT_MS = 30_000;

/** Prepares only a task-owned tab before its first delivery. Never sends or discards a draft. */
export class SessionPreparer {
  constructor(
    private readonly db: CouncilDB,
    private readonly browser: BrowserPort,
    private readonly profile: PageProfile,
    private readonly adapterVersion: string,
  ) {}
  private empty(observation: PageObservation, session: BrowserSession): boolean {
    let home = false;
    try {
      const url = new URL(observation.url),
        expected = new URL(this.profile.newConversationUrl);
      home =
        url.origin === expected.origin &&
        url.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '');
    } catch {
      home = false;
    }
    const preparation = session.preparation;
    const clearedByReset =
      preparation &&
      (preparation.resetHadTranscript ||
        (preparation.phase === 'reset_requested' &&
          preparation.userCount + preparation.outputCount > 0)) &&
      (preparation.phase === 'reset_requested' ||
        (preparation.phase === 'ready' && preparation.preparedUrl === observation.url));
    return (
      (observation.emptyConversation === true ||
        home ||
        clearedByReset ||
        observation.draftMatchesRequest === true) &&
      observation.editorFound &&
      (observation.editorEmpty || observation.draftMatchesRequest === true) &&
      observation.login === 'logged_in' &&
      !observation.blocked &&
      !observation.busy &&
      observation.outputCount === 0 &&
      observation.userCount === 0
    );
  }
  private async record(
    session: BrowserSession,
    observation: PageObservation,
    phase: NonNullable<BrowserSession['preparation']>['phase'],
    reason: string,
    requestedAt = session.preparation?.requestedAt,
  ): Promise<void> {
    session.preparation = {
      resetHadTranscript:
        session.preparation?.resetHadTranscript ||
        (phase === 'reset_requested' && observation.userCount + observation.outputCount > 0),
      preparedUrl: phase === 'ready' ? observation.url : undefined,
      readProof:
        observation.editorFound &&
        observation.login === 'logged_in' &&
        !observation.blocked &&
        !observation.busy &&
        observation.outputCount > 0 &&
        observation.completionControlFound
          ? { adapterVersion: this.adapterVersion, checkedAt: Date.now() }
          : session.preparation?.readProof,
      phase,
      requestedAt,
      checkedAt: Date.now(),
      editorFound: observation.editorFound,
      editorEmpty: observation.editorEmpty,
      userCount: observation.userCount,
      outputCount: observation.outputCount,
      reason,
    };
    await this.db.browser_sessions.update(session.id, { preparation: session.preparation });
  }
  async wait(session: BrowserSession): Promise<never> {
    if (Date.now() - (session.preparation?.requestedAt ?? 0) >= SESSION_PREPARATION_TIMEOUT_MS) {
      if (session.preparation) {
        session.preparation = {
          ...session.preparation,
          phase: 'blocked',
          checkedAt: Date.now(),
          reason: '点击新对话后 30 秒仍未确认空白会话；没有发送',
        };
        await this.db.browser_sessions.update(session.id, { preparation: session.preparation });
      }
      throw new CouncilError(
        'SESSION_NOT_EMPTY',
        '点击新对话后 30 秒仍未确认空白会话；没有向旧对话发送问题',
        false,
        true,
      );
    }
    throw new CouncilError(
      'SESSION_INITIALIZING',
      '正在等待专用标签页切换到空白新会话；尚未发送问题',
      true,
      true,
    );
  }
  private async validate(session: BrowserSession, observation: PageObservation): Promise<void> {
    const code = observation.blocked
      ? 'PAGE_CHALLENGE'
      : observation.login === 'logged_out'
        ? 'LOGGED_OUT'
        : !observation.editorEmpty && !observation.draftMatchesRequest
          ? 'DRAFT_PRESENT'
          : undefined;
    if (code) {
      const reason =
        code === 'PAGE_CHALLENGE'
          ? '新会话页面出现验证阻断'
          : code === 'LOGGED_OUT'
            ? '新会话页面需要登录'
            : '专用标签页出现未发送草稿；没有覆盖';
      await this.record(session, observation, 'blocked', reason);
      throw new CouncilError(code, reason, false, true);
    }
  }
  async ensureEmpty(
    session: BrowserSession,
    observation: PageObservation,
  ): Promise<PageObservation> {
    await this.validate(session, observation);
    const empty = this.empty(observation, session);
    if (empty) {
      await this.record(session, observation, 'ready', '已确认空白新会话');
      return observation;
    }
    if (session.preparation?.phase === 'reset_requested') return this.wait(session);
    if (!observation.editorFound)
      throw new CouncilError('PAGE_LOADING', '讨论专用页面尚未加载完成', true, true);
    if (observation.busy)
      throw new CouncilError('PAGE_BUSY', '网页正在生成其他回复，请等待', true, true);
    const requestedAt = Date.now();
    // Persist before clicking: a worker restart must inspect the result rather than click again.
    await this.record(
      session,
      observation,
      'reset_requested',
      '准备点击新对话；尚未发送问题',
      requestedAt,
    );
    let result: PageObservation;
    try {
      result = await requireValue(this.browser.page, '网页操作不可用').call(
        this.browser,
        session.tabId,
        { operation: 'new_conversation', profile: this.profile },
      );
    } catch (error) {
      if (
        error instanceof CouncilError &&
        ['SITE_PERMISSION_REQUIRED', 'ORIGIN_MISMATCH', 'SESSION_TAB_CLOSED'].includes(error.code)
      )
        throw new CouncilError(error.code, error.message, error.retryable, true);
      await log(this.db, 'warn', 'SESSION_RESET_CHECK_PENDING', session.id, session.discussionId);
      return this.wait(session);
    }
    await this.validate(session, result);
    if (result.newConversationState === 'not_found' || result.newConversationState === undefined) {
      const reason = result.reason || '未确认新对话按钮可用；没有发送';
      await this.record(session, result, 'blocked', reason, requestedAt);
      throw new CouncilError('SESSION_NOT_EMPTY', reason, false, true);
    }
    if (this.empty(result, session)) {
      await this.record(session, result, 'ready', '已确认空白新会话', requestedAt);
      return result;
    }
    await this.record(
      session,
      result,
      'reset_requested',
      result.reason || '等待网页切换到空白新会话',
      requestedAt,
    );
    await log(this.db, 'info', 'SESSION_RESET_REQUESTED', session.id, session.discussionId);
    return this.wait(session);
  }
}
