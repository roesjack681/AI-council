import type { CouncilDB } from '../../database/db';
import {
  isBrainDiscussion,
  type Participant,
  type CapabilityCheck,
  type QueueTask,
  type BrowserSession,
  type BrowserDelivery,
} from '../../protocols/domain';
import type {
  BrowserPort,
  PlatformAdapter,
  Receipt,
  PollResult,
  Reconciliation,
} from '../base/adapter.interface';
import type { PageProfile, PageObservation } from './page-protocol';
import { noCapabilities } from '../base/capability';
import { CouncilError, requireValue } from '../../utils/errors';
import { SessionPreparer } from './session-preparer';
import { log } from '../../utils/logger';
import { terminal } from '../../core/task-manager';
import { DraftRecovery } from './draft-recovery';
import { requestMarker, webPrompt } from './request-wire';

export interface PolicyMetadata {
  policy: 'restricted' | 'unverified' | 'allowed';
  reason: string;
  sources: readonly string[];
}
export class BrowserDomAdapter implements PlatformAdapter {
  readonly version = '2.0.9';
  readonly id: string;
  readonly origins: readonly string[];
  constructor(
    private readonly db: CouncilDB,
    private readonly browser: BrowserPort,
    private readonly profile: PageProfile,
    private readonly policy: PolicyMetadata,
  ) {
    this.id = profile.id;
    this.origins = profile.origins;
  }
  async inspect(
    _participant: Participant,
    browser: BrowserPort,
    onlyTabId?: number,
    prepared = false,
  ): Promise<CapabilityCheck> {
    const tabs = (await browser.tabs()).filter((t) => {
      try {
        return (
          (onlyTabId === undefined || t.id === onlyTabId) &&
          this.origins.includes(new URL(t.url).origin)
        );
      } catch {
        return false;
      }
    });
    const base: CapabilityCheck = {
      interactionMode: 'browser_dom',
      checkedAt: Date.now(),
      adapterVersion: this.version,
      tabIds: tabs.map((t) => t.id),
      pageOpen: tabs.length > 0,
      pageReachable: 'unknown',
      login: 'unknown',
      policy: this.policy.policy,
      technicalVerified: false,
      capabilities: noCapabilities(),
      reasons: [],
      sources: [...this.policy.sources],
      diagnostics: [],
    };
    if (!this.browser.page || !this.browser.create)
      return {
        ...base,
        failureCode: 'BROWSER_UNAVAILABLE',
        reasons: ['当前环境没有 Chrome 网页操作能力。请使用已安装的扩展。'],
      };
    if (!tabs.length)
      return {
        ...base,
        failureCode: 'PAGE_NOT_OPEN',
        reasons: ['未找到该平台标签页，请打开平台官网并登录。'],
      };
    const samples: PageObservation[] = [];
    let permissionMissing = false;
    for (const tab of tabs) {
      try {
        const result = await this.browser.page(tab.id, {
          operation: 'inspect',
          profile: this.profile,
        });
        samples.push(result);
        base.diagnostics!.push({
          tabId: tab.id,
          origin: new URL(tab.url).origin,
          editorFound: result.editorFound,
          emptyConversation: result.emptyConversation,
          outputCount: result.outputCount,
          completionControlFound: result.completionControlFound,
          busy: result.busy,
          login: result.login,
          selectors: result.selectors,
          structure: result.structure,
        });
      } catch (error) {
        if (error instanceof CouncilError && error.code === 'SITE_PERMISSION_REQUIRED')
          permissionMissing = true;
        base.diagnostics!.push({
          tabId: tab.id,
          origin: new URL(tab.url).origin,
          errorCode: error instanceof CouncilError ? error.code : 'PAGE_PROBE_FAILED',
        });
      }
    }
    if (!samples.length)
      return {
        ...base,
        failureCode: permissionMissing ? 'SITE_PERMISSION_REQUIRED' : 'PAGE_PROBE_FAILED',
        reasons: [
          permissionMissing
            ? '尚未授予该网站访问权限。请点击“检查能力”，允许 Chrome 的对应网站访问请求。'
            : '网页检查失败，请刷新模型网页后重试。',
        ],
      };
    const sample =
      samples.find(
        (s) =>
          s.login === 'logged_in' &&
          !s.blocked &&
          !s.busy &&
          s.editorFound &&
          s.outputCount > 0 &&
          s.completionControlFound,
      ) ??
      samples.find(
        (s) => s.emptyConversation === true && s.login === 'logged_in' && !s.blocked && !s.busy,
      ) ??
      samples.find((s) => s.editorFound) ??
      samples[0]!;
    const ready =
      sample.login === 'logged_in' &&
      !sample.blocked &&
      !sample.busy &&
      sample.editorFound &&
      sample.submitControlFound &&
      sample.outputCount > 0 &&
      sample.completionControlFound;
    const homePath =
      (() => {
        try {
          return new URL(sample.url).pathname;
        } catch {
          return '';
        }
      })() || '';
    // Welcome-copy detection can lag UI refresh; a clean editor on the platform home route
    // is enough to authorize a bounded first-message attempt (still not full unattended readiness).
    const cleanHomeEditor =
      sample.emptyConversation === true ||
      (this.profile.id === 'deepseek' && homePath === '/') ||
      (this.profile.id === 'gemini' && /^\/app\/?$/.test(homePath)) ||
      (this.profile.id === 'chatgpt' && homePath === '/');
    const firstMessageAllowed =
      (prepared ||
        (['deepseek', 'gemini', 'chatgpt'].includes(this.profile.id) && cleanHomeEditor)) &&
      sample.login === 'logged_in' &&
      !sample.blocked &&
      !sample.busy &&
      sample.editorFound &&
      (sample.editorEmpty || prepared) &&
      sample.submitControlFound &&
      sample.outputCount === 0 &&
      sample.userCount === 0 &&
      !sample.completionControlFound;
    const capabilities = {
      canReadOutput: sample.outputCount > 0,
      canSubmitMessage: sample.editorFound && sample.submitControlFound,
      canDetectCompletion: sample.completionControlFound || sample.busy,
      canDetectLogin: true,
      canCaptureUserQuestion: false,
      unattendedAllowed: ready,
    };
    const failureCode = ready
      ? undefined
      : firstMessageAllowed
        ? 'FIRST_REPLY_PENDING'
        : sample.blocked
          ? 'PAGE_CHALLENGE'
          : sample.login === 'logged_out'
            ? 'LOGGED_OUT'
            : !sample.editorFound
              ? 'EDITOR_NOT_FOUND'
              : sample.busy
                ? 'PAGE_BUSY'
                : sample.outputCount === 0
                  ? 'OUTPUT_NOT_FOUND'
                  : !sample.completionControlFound
                    ? 'COMPLETION_NOT_FOUND'
                    : 'PAGE_NOT_READY';
    const reasons = ready
      ? ['网页输入框、回复区域和完成操作栏已匹配，可以尝试自动讨论。实际发送与完整回复仍逐条核对。']
      : firstMessageAllowed
        ? [
            '已确认平台空白首页，可以发送首条问题；读取和完成检测将在首条真实回复中验证。未验证前不会交接回复或宣布任务完成。',
          ]
        : sample.blocked
          ? ['网页出现验证或访问阻断，请自行处理后重试。']
          : sample.login === 'logged_out'
            ? ['请先在平台官网自行登录。']
            : !sample.editorFound
              ? [
                  '未匹配到当前网页的消息输入框。已有回答也不能代替输入框检测；请查看下面的页面诊断。',
                ]
              : sample.busy
                ? ['网页正在生成回答，请等待结束后重新检查。']
                : sample.outputCount === 0
                  ? [
                      '已匹配输入框，尚无可读取的回复样例。发送问题时会自动建立并准备专用会话，不需要手动发送测试消息或新建聊天。',
                    ]
                  : ['输入框和回复区已匹配，但没有匹配到回答完成控件。请查看页面诊断。'];
    return {
      ...base,
      sessionPreparationAllowed:
        sample.login === 'logged_in' &&
        !sample.blocked &&
        sample.editorFound &&
        sample.submitControlFound,
      firstMessageAllowed,
      failureCode,
      pageReachable: 'yes',
      login: sample.login,
      technicalVerified: ready,
      capabilities,
      reasons: [
        ...reasons,
        '当前为用户指定的网页 DOM 操作模式；平台规则信息单独展示，不作为硬编码停止开关。',
      ],
    };
  }
  async prepareInitial(participant: Participant, discussionId: string): Promise<CapabilityCheck> {
    const session = await this.session({ discussionId, participantId: participant.id });
    const owned = await this.db.browser_deliveries
      .where('discussionId')
      .equals(discussionId)
      .filter((item) => item.participantId === participant.id)
      .count();
    // Existing dispatches are never reset or replayed by a page preparation call.
    if (owned) return this.inspect(participant, this.browser, session.tabId);
    try {
      const queued = await this.db.task_queue
        .where('discussionId')
        .equals(discussionId)
        .filter((task) => task.participantId === participant.id && task.status === 'pending')
        .first();
      const outbound = queued ? await this.db.messages.get(queued.messageId) : undefined;
      const marker = queued ? requestMarker(queued.dedupeKey) : undefined;
      const prompt =
        outbound && marker ? webPrompt(outbound.content, queued!.dedupeKey) : undefined;
      let before = await this.read(session.tabId, 'inspect', marker, prompt, true, true);
      before = await new DraftRecovery(this.db, this.browser, this.profile).moveStale(
        session,
        before,
        marker,
      );
      await new SessionPreparer(this.db, this.browser, this.profile, this.version).ensureEmpty(
        session,
        before,
      );
      return this.inspect(participant, this.browser, session.tabId, true);
    } catch (error) {
      if (!(error instanceof CouncilError)) throw error;
      const check = await this.inspect(participant, this.browser, session.tabId);
      return {
        ...check,
        firstMessageAllowed: false,
        sessionPreparationAllowed: false,
        technicalVerified: false,
        capabilities: { ...check.capabilities, unattendedAllowed: false },
        failureCode: error.code,
        reasons: [error.message],
      };
    }
  }
  private async read(
    tabId: number,
    operation: 'inspect' | 'observe',
    marker?: string,
    prompt?: string,
    activate = false,
    captureDraft = false,
  ): Promise<PageObservation> {
    const page = requireValue(this.browser.page, '网页操作不可用').bind(this.browser);
    const tabs = await this.browser.tabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab)
      throw new CouncilError('SESSION_TAB_CLOSED', '讨论专用标签页已关闭；没有重新发送消息');
    if (!this.origins.includes(new URL(tab.url).origin))
      throw new CouncilError('SESSION_ORIGIN_CHANGED', '讨论标签页已跳转到其他网站');
    if (operation === 'inspect' && tab.status === 'loading')
      throw new CouncilError('PAGE_LOADING', '讨论专用标签页正在加载；尚未执行发送', true, true);
    const result = await page(tabId, {
      operation,
      profile: this.profile,
      marker,
      prompt,
      activate,
      captureDraft,
    });
    if (result.blocked)
      throw new CouncilError('PAGE_CHALLENGE', '网页出现验证或访问阻断，请自行处理');
    if (result.login === 'logged_out') throw new CouncilError('LOGGED_OUT', '请在平台官网自行登录');
    return result;
  }
  private async session(
    task: Pick<QueueTask, 'discussionId' | 'participantId'>,
  ): Promise<BrowserSession> {
    const id = `${task.discussionId}:${task.participantId}`;
    const tabs = await this.browser.tabs();
    const previous = await this.db.browser_sessions.get(id);
    if (previous) {
      const open = tabs.some((tab) => tab.id === previous.tabId);
      if (open) return previous;
      const deliveries = await this.db.browser_deliveries
        .where('discussionId')
        .equals(task.discussionId)
        .filter((delivery) => delivery.participantId === task.participantId)
        .count();
      if (deliveries > 0)
        throw new CouncilError(
          'SESSION_TAB_CLOSED',
          '讨论专用标签页已关闭且存在发送记录；不会新建会话重发',
        );
      // There is no durable dispatch record for this participant, so replacement cannot replay a send.
    }
    // One open tab per participant across questions, but never mix the brain router tab
    // with council/direct discussion tabs for the same platform account.
    const taskIsBrain = isBrainDiscussion(task.discussionId);
    const completed = new Set(
      (await this.db.discussions.toArray())
        .filter((discussion) => terminal(discussion.status))
        .map((discussion) => discussion.id),
    );
    for (const request of await this.db.brain_requests.toArray())
      if (request.phase === 'done' || request.phase === 'cancelled')
        completed.add(request.task.discussionId);
    const inFlightTabs = new Set(
      (await this.db.browser_deliveries.toArray())
        .filter((delivery) => delivery.phase !== 'complete')
        .map((delivery) => delivery.tabId),
    );
    const reusable = (
      await this.db.browser_sessions.where('participantId').equals(task.participantId).toArray()
    )
      .filter((row) => {
        if (row.id === id || !tabs.some((tab) => tab.id === row.tabId)) return false;
        if (!completed.has(row.discussionId)) return false;
        if (inFlightTabs.has(row.tabId)) return false;
        const rowIsBrain = isBrainDiscussion(row.discussionId);
        return rowIsBrain === taskIsBrain;
      })
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (reusable) {
      const session: BrowserSession = {
        id,
        discussionId: task.discussionId,
        participantId: task.participantId,
        tabId: reusable.tabId,
        origin: this.origins[0]!,
        createdAt: Date.now(),
      };
      await this.db.browser_sessions.put(session);
      await log(
        this.db,
        'info',
        'SESSION_TAB_REUSED',
        `participant=${task.participantId}; tab=${reusable.tabId}; from=${reusable.discussionId}; to=${task.discussionId}`,
        task.discussionId,
      );
      return session;
    }
    const create = requireValue(this.browser.create, '无法创建独立讨论标签页').bind(this.browser);
    const tab = await create(this.profile.newConversationUrl);
    const session: BrowserSession = {
      id,
      discussionId: task.discussionId,
      participantId: task.participantId,
      tabId: tab.id,
      origin: this.origins[0]!,
      createdAt: Date.now(),
    };
    await this.db.browser_sessions.put(session);
    if (previous)
      await log(
        this.db,
        'info',
        'UNSENT_SESSION_RECREATED',
        `participant=${task.participantId}; oldTab=${previous.tabId}; newTab=${tab.id}; no delivery records`,
        task.discussionId,
      );
    return session;
  }
  async submit(task: QueueTask, prompt: string, key: string): Promise<Receipt> {
    const prior = await this.db.browser_deliveries.get(key);
    if (prior) {
      const known = await this.reconcile(task, key);
      if (known.state === 'submitted') return known.receipt;
      throw new CouncilError('DELIVERY_UNKNOWN', '已有网页发送记录，尚不能确认结果；不会重复提交');
    }
    const session = await this.session(task);
    const marker = requestMarker(key);
    const fullPrompt = webPrompt(prompt, key);
    const preparer = new SessionPreparer(this.db, this.browser, this.profile, this.version);
    let before: PageObservation;
    try {
      before = await this.read(session.tabId, 'inspect', marker, fullPrompt, false, true);
      before = await new DraftRecovery(this.db, this.browser, this.profile).moveStale(
        session,
        before,
        marker,
      );
    } catch (error) {
      if (
        session.preparation?.phase === 'reset_requested' &&
        (!(error instanceof CouncilError) ||
          ['PAGE_LOADING', 'PAGE_PROBE_FAILED', 'PAGE_CHECK_FAILED'].includes(error.code))
      )
        return preparer.wait(session);
      if (error instanceof CouncilError)
        throw new CouncilError(error.code, error.message, error.retryable, true);
      throw new CouncilError('PAGE_CHECK_FAILED', '网页检查失败；没有执行发送', true, true);
    }
    if (!before.editorFound && session.preparation?.phase === 'reset_requested')
      return preparer.wait(session);
    if (!before.editorFound)
      throw new CouncilError('PAGE_LOADING', '讨论专用页面尚未加载完成', true, true);
    if (before.busy && session.preparation?.phase === 'reset_requested')
      return preparer.wait(session);
    if (before.busy)
      throw new CouncilError('PAGE_BUSY', '网页正在生成其他回复，请等待', true, true);
    if (!before.editorEmpty && !before.draftMatchesRequest)
      throw new CouncilError('DRAFT_PRESENT', '讨论页面存在未发送草稿，未覆盖', false, true);
    const owned = await this.db.browser_deliveries
      .where('discussionId')
      .equals(task.discussionId)
      .filter((item) => item.participantId === task.participantId)
      .count();
    if (owned === 0) before = await preparer.ensureEmpty(session, before);
    const delivery: BrowserDelivery = {
      id: key,
      discussionId: task.discussionId,
      participantId: task.participantId,
      tabId: session.tabId,
      marker,
      phase: 'prepared',
      submittedAt: Date.now(),
      lastText: '',
      lastChangedAt: Date.now(),
      observations: 0,
      generationSeen: false,
    };
    await this.db.browser_deliveries.add(delivery);
    const page = requireValue(this.browser.page, '网页操作不可用').bind(this.browser);
    const result = await page(session.tabId, {
      operation: 'submit',
      profile: this.profile,
      marker,
      prompt: fullPrompt,
    });
    if (!result.markerFound) {
      if (!result.dispatched) {
        await this.db.browser_deliveries.delete(key);
        throw new CouncilError(
          result.login === 'logged_out'
            ? 'LOGGED_OUT'
            : result.blocked
              ? 'PAGE_CHALLENGE'
              : 'PAGE_NOT_READY',
          result.reason || '网页未接受消息；没有发送',
          false,
          true,
        );
      }
      throw new CouncilError('DELIVERY_UNKNOWN', '网页发送结果待核对，不自动重发');
    }
    await this.db.browser_deliveries.update(key, {
      phase: 'submitted',
      generationSeen: result.busy,
    });
    return { id: key, submittedAt: delivery.submittedAt };
  }
  async reconcile(task: QueueTask, key: string): Promise<Reconciliation> {
    const delivery = await this.db.browser_deliveries.get(key);
    // Every dispatch is preceded by a durable delivery record. No record proves dispatch was never reached.
    if (!delivery) return { state: 'not_sent' };
    if (
      delivery.discussionId !== task.discussionId ||
      delivery.participantId !== task.participantId
    )
      throw new CouncilError('CROSS_TASK_RECEIPT', '网页凭据归属不一致');
    const result = await this.read(delivery.tabId, 'observe', delivery.marker);
    if (!result.markerFound) return { state: 'unknown' };
    await this.db.browser_deliveries.update(key, {
      phase: delivery.phase === 'complete' ? 'complete' : 'submitted',
      generationSeen: delivery.generationSeen || result.busy,
    });
    return { state: 'submitted', receipt: { id: key, submittedAt: delivery.submittedAt } };
  }
  async poll(task: QueueTask, receipt: Receipt): Promise<PollResult> {
    const delivery = requireValue(
      await this.db.browser_deliveries.get(receipt.id),
      '网页发送记录不存在',
    );
    if (
      delivery.discussionId !== task.discussionId ||
      delivery.participantId !== task.participantId
    )
      throw new CouncilError('CROSS_TASK_RECEIPT', '网页凭据归属不一致');
    if (delivery.phase === 'complete' && delivery.raw)
      return { state: 'complete', externalMessageId: delivery.id, raw: delivery.raw };
    const result = await this.read(delivery.tabId, 'observe', delivery.marker);
    if (!result.markerFound)
      throw new CouncilError(
        'MESSAGE_NOT_FOUND',
        '网页找不到本请求标记；可能切换了对话，不会拿其他回复代替',
      );
    const changed = result.raw !== delivery.lastText;
    const observed = delivery.observations + 1;
    const changedAt = changed ? Date.now() : delivery.lastChangedAt;
    const generationSeen = delivery.generationSeen || result.busy;
    const complete =
      Boolean(result.raw) &&
      !result.busy &&
      result.completionControlFound &&
      !changed &&
      observed >= 2 &&
      Date.now() - changedAt >= 4000;
    await this.db.browser_deliveries.update(delivery.id, {
      phase: complete ? 'complete' : 'submitted',
      lastText: result.raw,
      lastChangedAt: changedAt,
      observations: observed,
      generationSeen,
      ...(complete ? { raw: result.raw } : {}),
    });
    return complete
      ? { state: 'complete', externalMessageId: delivery.id, raw: result.raw }
      : { state: 'pending' };
  }
  async cachedResponse(
    task: QueueTask,
    receipt: Receipt,
  ): Promise<Extract<PollResult, { state: 'complete' }> | undefined> {
    const delivery = await this.db.browser_deliveries.get(receipt.id);
    if (!delivery) return undefined;
    if (
      delivery.discussionId !== task.discussionId ||
      delivery.participantId !== task.participantId
    )
      throw new CouncilError('CROSS_TASK_RECEIPT', '网页凭据归属不一致');
    return delivery.phase === 'complete' && delivery.raw
      ? { state: 'complete', externalMessageId: delivery.id, raw: delivery.raw }
      : undefined;
  }
}
