import type { CouncilDB } from '../database/db';
import type { AdapterRegistry } from '../adapters/registry';
import type { ComplianceGate } from '../adapters/base/compliance-gate';
import type { DiscussionEngine } from '../core/discussion-engine';
import type { Scheduler } from '../background/scheduler';
import { TaskManager } from '../core/task-manager';
import {
  buildBrainRoutePrompt,
  normalizeBrainRoute,
  resolveRouteTargets,
  namesMentionedInQuestion,
} from '../core/brain-router';
import {
  type BrainRoute,
  type Participant,
  type BrainRequest,
  type VerificationPolicy,
} from '../protocols/domain';
import { CouncilError } from '../utils/errors';
import { BrainRequestRunner } from './brain-request-runner';
import { isReady, canBeginFirstMessage } from '../adapters/base/capability';
import { log } from '../utils/logger';
import { RequestCoordinator } from '../core/request-coordinator';

export type ChatAskResult = {
  intent: BrainRoute['intent'] | 'routing';
  requestId?: string;
  brief: string;
  discussionId?: string;
  noticeIds: string[];
  usedBrain: boolean;
};

export class ChatAskService {
  private readonly runner: BrainRequestRunner;
  private readonly coordinator: RequestCoordinator;
  constructor(
    private readonly db: CouncilDB,
    private readonly gate: ComplianceGate,
    private readonly registry: AdapterRegistry,
    private readonly engine: DiscussionEngine,
    private readonly scheduler: Scheduler,
  ) {
    this.coordinator = new RequestCoordinator(db);
    this.runner = new BrainRequestRunner(db, gate, (request, route) =>
      this.applyRoute(request, route),
    );
  }

  private councilMembers(all: Participant[]): Participant[] {
    return all.filter((p) => p.enabled && (p.role ?? 'council') !== 'brain');
  }

  private async readyCouncil(all: Participant[]): Promise<Participant[]> {
    const ready: Participant[] = [];
    for (const participant of this.councilMembers(all)) {
      const check = await this.gate.inspect(participant.id);
      const adapter = this.registry.find(participant.adapterId);
      if (
        adapter &&
        (adapter.prepareInitial ||
          isReady(check, adapter.version) ||
          canBeginFirstMessage(check, adapter.version))
      )
        ready.push(participant);
    }
    return ready;
  }
  async advance(): Promise<void> {
    await this.runner.step();
  }
  async resume(id: string): Promise<void> {
    await this.coordinator.activateBrain(id);
    await this.runner.resume(id);
  }
  async cancel(id: string): Promise<void> {
    await this.runner.cancel(id);
  }

  private async startDiscussion(
    userQuestion: string,
    members: Participant[],
    mode: 'free' | 'direct',
    brain?: { brief: string; intent: BrainRoute['intent']; task?: string },
    requestId?: string,
    verificationPolicy: VerificationPolicy = 'discussion_only',
    userRequestId?: string,
  ): Promise<string> {
    if (mode === 'free' && members.length < 2)
      throw new CouncilError('NEED_MEMBERS', '共识讨论至少需要两名就绪的讨论成员（不含大脑）');
    if (mode === 'direct' && members.length < 1)
      throw new CouncilError('NEED_TARGET', '点名任务没有可送达的成员');
    const tasks = new TaskManager(this.db);
    const routedTask = brain?.task?.trim() || '';
    const title = userQuestion.length > 40 ? `${userQuestion.slice(0, 40)}…` : userQuestion;
    // Chat room always shows the user's words; routed task is only guidance for members.
    const context =
      routedTask && routedTask !== userQuestion
        ? `调度任务（给成员执行，勿覆盖用户原话）：\n${routedTask}`
        : '';
    const created = await this.db.transaction('rw', this.db.tables, async () => {
      if (!(await this.coordinator.isCurrent(userRequestId)))
        throw new CouncilError('REQUEST_SUPERSEDED', '旧路由不能创建新题');
      const job = requestId ? await this.db.brain_requests.get(requestId) : undefined;
      if (job?.discussionId) {
        const existing = await this.db.discussions.get(job.discussionId);
        if (!existing) throw new CouncilError('ROUTE_TASK_MISSING', '已关联的路由任务不存在');
        if (userRequestId) {
          await this.db.discussions.update(existing.id, { userRequestId });
          existing.userRequestId = userRequestId;
        }
        return existing;
      }
      const discussion = await tasks.create({
        title,
        originalQuestion: userQuestion,
        context,
        constraints: [],
        expectedOutput: '',
        mode,
        verificationPolicy,
        participantIds: members.map((m) => m.id),
        maxRounds: mode === 'direct' ? 2 : 10,
        // Chat room: one clean all-agree round is enough; extra confirmation rounds feel "stuck".
        stableRoundsRequired: 1,
        timeoutMs: 180_000,
        maxRetries: 2,
        privacyAcknowledged: true,
        brainBrief: brain?.brief,
        brainIntent: brain?.intent,
      });
      if (userRequestId) {
        discussion.userRequestId = userRequestId;
        await this.db.discussions.update(discussion.id, { userRequestId });
      }
      if (requestId)
        await this.db.brain_requests.update(requestId, { discussionId: discussion.id });
      return discussion;
    });
    if (userRequestId) await this.coordinator.bind(userRequestId, { discussionId: created.id });
    await this.engine.start(created.id);
    await this.scheduler.tick();
    return created.id;
  }

  async ask(
    question: string,
    verificationPolicy: VerificationPolicy = 'discussion_only',
  ): Promise<ChatAskResult> {
    const text = question.trim();
    if (!text) throw new CouncilError('EMPTY_QUESTION', '问题不能为空');
    const all = await this.db.participants.toArray();
    const userRequestId = await this.coordinator.begin();
    const named = resolveRouteTargets(namesMentionedInQuestion(text, all), all);
    const addressed = named.matched.filter(
      (member) => text.startsWith(member.name) || text.startsWith(`@${member.name}`),
    );
    if (named.unresolved.length)
      throw new CouncilError('AMBIGUOUS_TARGET', '成员名称有歧义，请使用唯一名称');
    if (named.matched.length === 1 && addressed.length === 1) {
      const discussionId = await this.startDiscussion(
        text,
        addressed,
        'direct',
        undefined,
        undefined,
        verificationPolicy,
        userRequestId,
      );
      return {
        intent: 'direct_ask',
        discussionId,
        brief: '已按本次原话发给点名成员。',
        noticeIds: [],
        usedBrain: false,
      };
    }
    const brain = all.find((p) => p.enabled && (p.role ?? 'council') === 'brain');
    const ready = brain ? [] : await this.readyCouncil(all);
    const noticeIds: string[] = [];

    if (!brain) {
      const brief =
        '未指定大脑，已按全体就绪成员开启共识讨论。可在设置里把某个模型设为大脑以启用智能路由。';
      const discussionId = await this.startDiscussion(
        text,
        ready,
        'free',
        {
          brief,
          intent: 'council_discuss',
        },
        undefined,
        verificationPolicy,
        userRequestId,
      );
      return { intent: 'council_discuss', brief, discussionId, noticeIds, usedBrain: false };
    }

    const request = await this.runner.enqueue(
      brain.id,
      text,
      buildBrainRoutePrompt(text, all),
      verificationPolicy,
      userRequestId,
    );
    await this.coordinator.bind(userRequestId, { brainRequestId: request.id });
    return {
      intent: 'routing',
      requestId: request.id,
      brief: '已保存问题，正在等待大脑路由。',
      noticeIds,
      usedBrain: true,
    };
  }

  private async applyRoute(
    request: BrainRequest,
    response: BrainRoute,
  ): Promise<{ discussionId?: string; noticeIds: string[] }> {
    const all = await this.db.participants.toArray();
    const text = request.question;
    if (!(await this.coordinator.isCurrent(request.userRequestId)))
      throw new CouncilError('REQUEST_SUPERSEDED', '旧路由已停止，没有执行旧问题');
    const route = normalizeBrainRoute(response, text, all);
    const noticeIds: string[] = [];
    await log(this.db, 'info', 'BRAIN_ROUTE', `${request.id}: ${route.intent}`);
    if (route.intent === 'check_ready') {
      const lines: string[] = [];
      for (const p of this.councilMembers(all)) {
        const check = await this.gate.inspect(p.id);
        lines.push(
          `${p.name}：${check.capabilities.unattendedAllowed || check.firstMessageAllowed ? '就绪/可首轮' : check.failureCode || '未就绪'}`,
        );
      }
      const id = `${request.id}:readiness`;
      await this.db.chat_notices.put({
        id,
        type: 'readiness',
        title: '就绪检查',
        body: lines.join('\n') || '暂无讨论成员',
        createdAt: request.createdAt,
      });
      return { noticeIds: [id] };
    }
    const { matched, unresolved } = resolveRouteTargets(route.targets, all);
    if (unresolved.length)
      throw new CouncilError(
        'UNKNOWN_ROUTE_TARGET',
        `无法匹配目标：${unresolved.join('、')}。没有转发给其他成员`,
      );
    const mode = route.intent === 'direct_ask' ? 'direct' : 'free';
    if (mode === 'direct' && !matched.length)
      throw new CouncilError('NEED_TARGET', '大脑未给出可识别的点名目标，没有改发给全员');
    const members = matched.length ? matched : await this.readyCouncil(all);
    const discussionId = await this.startDiscussion(
      text,
      members,
      mode,
      { brief: route.brief, intent: route.intent, task: route.task },
      request.id,
      request.verificationPolicy,
      request.userRequestId,
    );
    return { discussionId, noticeIds };
  }
}
