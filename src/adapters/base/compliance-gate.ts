import type { CouncilDB } from '../../database/db';
import type { Participant, CapabilityCheck, QueueTask } from '../../protocols/domain';
import type { CompletedResponse } from './adapter.interface';
import type { BrowserPort, PlatformAdapter } from './adapter.interface';
import { AdapterRegistry } from '../registry';
import {
  isReady,
  noCapabilities,
  canBeginFirstMessage,
  canObserveResponse,
  canPrepareSession,
} from './capability';
import { CouncilError, requireValue } from '../../utils/errors';
import { log } from '../../utils/logger';
export class ComplianceGate {
  constructor(
    private readonly db: CouncilDB,
    private readonly registry: AdapterRegistry,
    private readonly browser: BrowserPort,
  ) {}
  async inspect(id: string, prepareDiscussionId?: string): Promise<CapabilityCheck> {
    const p = requireValue(await this.db.participants.get(id), '参与者不存在');
    const adapter = this.registry.find(p.adapterId);
    let check: CapabilityCheck;
    try {
      if (!adapter) throw new CouncilError('UNSUPPORTED_ADAPTER', '未安装适配器');
      if (!adapter.origins.includes(new URL(p.websiteUrl).origin))
        throw new CouncilError('ORIGIN_MISMATCH', '平台网址不属于该适配器');
      check =
        prepareDiscussionId && adapter.prepareInitial
          ? await adapter.prepareInitial(p, prepareDiscussionId)
          : await adapter.inspect(p, this.browser);
    } catch (error) {
      check = {
        checkedAt: Date.now(),
        adapterVersion: adapter?.version ?? 'none',
        tabIds: [],
        pageOpen: false,
        pageReachable: 'unknown',
        login: 'unknown',
        policy: 'unverified',
        technicalVerified: false,
        capabilities: noCapabilities(),
        reasons: [error instanceof CouncilError ? error.message : '自动页面检查失败，未执行发送。'],
        sources: [],
        failureCode: error instanceof CouncilError ? error.code : 'CAPABILITY_CHECK_FAILED',
      };
      await log(this.db, 'error', 'CAPABILITY_CHECK_FAILED', p.id);
    }
    const ready = adapter ? isReady(check, adapter.version) : false;
    const status: Participant['status'] = ready
      ? 'available'
      : adapter &&
          (canBeginFirstMessage(check, adapter.version) ||
            canPrepareSession(check, adapter.version))
        ? 'first_message_ready'
        : check.login === 'logged_out'
          ? 'logged_out'
          : check.interactionMode === 'browser_dom'
            ? 'unsupported'
            : check.policy === 'restricted'
              ? 'restricted'
              : adapter
                ? 'unsupported'
                : 'error';
    await this.db.participants.update(id, {
      check,
      capabilities: {
        ...check.capabilities,
        unattendedAllowed: ready && check.capabilities.unattendedAllowed,
      },
      status,
      reason: check.reasons.join('\n'),
      adapterVersion: adapter?.version ?? 'none',
      updatedAt: Date.now(),
    });
    await log(
      this.db,
      ready || status === 'first_message_ready' ? 'info' : 'warn',
      'CAPABILITY_CHECK',
      `${p.id}: ${status}`,
    );
    return check;
  }
  async requireReady(
    id: string,
    phase: 'verified' | 'initial' | 'observe' = 'verified',
    discussionId?: string,
  ): Promise<PlatformAdapter> {
    const p = requireValue(await this.db.participants.get(id), '参与者不存在');
    if (!p.enabled) throw new CouncilError('PARTICIPANT_DISABLED', '参与者已停用');
    const check = await this.inspect(id, phase === 'initial' ? discussionId : undefined);
    const adapter = this.registry.get(p.adapterId);
    const initialAttempt = phase === 'initial' && canBeginFirstMessage(check, adapter.version);
    const observeOnly = phase === 'observe' && canObserveResponse(check, adapter.version);
    const session =
      phase === 'initial' && discussionId
        ? await this.db.browser_sessions.get(`${discussionId}:${id}`)
        : undefined;
    // A task-owned page was readable immediately before its recorded reset. A cleared page has no
    // sample by definition; permit this initial attempt without changing its unverified capability flags.
    const preparedAttempt =
      phase === 'initial' &&
      session?.discussionId === discussionId &&
      session?.participantId === id &&
      session?.preparation?.readProof?.adapterVersion === adapter.version &&
      session.preparation.readProof.checkedAt <= Date.now() &&
      canObserveResponse(check, adapter.version);
    if (!isReady(check, adapter.version) && !initialAttempt && !observeOnly && !preparedAttempt)
      throw new CouncilError(
        check.login === 'logged_out' ? 'LOGGED_OUT' : (check.failureCode ?? 'AUTOMATION_BLOCKED'),
        `${p.name}：${check.reasons[0] ?? '当前网页未就绪。'}（输入框：${check.capabilities.canSubmitMessage ? '已匹配' : '未匹配'}；回复区：${check.capabilities.canReadOutput ? '已匹配' : '未匹配'}；完成检测：${check.capabilities.canDetectCompletion ? '已匹配' : '未匹配'}）`,
      );
    return adapter;
  }
  async cachedResponse(task: QueueTask): Promise<CompletedResponse | undefined> {
    if (task.status !== 'waiting' || !task.receiptId) return undefined;
    const participant = requireValue(
      await this.db.participants.get(task.participantId),
      '参与者不存在',
    );
    if (!participant.enabled) return undefined;
    return this.registry.get(participant.adapterId).cachedResponse?.(task, {
      id: task.receiptId,
      submittedAt: task.startedAt ?? task.createdAt,
    });
  }
}
