import type { CouncilDB } from '../database/db';
import type { DiscussionMessage, ModelResponse, Objection } from '../protocols/domain';
import { normalize, newId } from '../utils/id';
import { CouncilError, requireValue } from '../utils/errors';
export class ObjectionEngine {
  constructor(private readonly db: CouncilDB) {}
  async apply(
    message: DiscussionMessage,
    inputs: ModelResponse['objections'],
    reviews: ModelResponse['resolutions'],
  ): Promise<string[]> {
    const discussion = requireValue(
      await this.db.discussions.get(message.discussionId),
      '任务不存在',
    );
    const ids: string[] = [];
    for (const input of inputs) {
      const claim = requireValue(await this.db.claims.get(input.claimId), '争议引用了不存在的结论');
      if (
        claim.discussionId !== message.discussionId ||
        input.targetParticipantIds.some((id) => !discussion.participantIds.includes(id))
      )
        throw new CouncilError('CROSS_TASK_OBJECTION', '争议引用跨任务数据');
      const same = (
        await this.db.objections.where('discussionId').equals(message.discussionId).toArray()
      ).find(
        (o) =>
          o.sourceParticipantId === message.participantId &&
          o.relatedClaimId === claim.id &&
          o.claimVersion === claim.version &&
          normalize(o.description) === normalize(input.description),
      );
      if (same) {
        ids.push(same.id);
        continue;
      }
      const o: Objection = {
        ...input,
        id: newId(),
        discussionId: message.discussionId,
        sourceParticipantId: message.participantId,
        relatedClaimId: claim.id,
        claimVersion: claim.version,
        status: 'open',
        reviews: [],
        sourceMessageId: message.id,
        createdAt: Date.now(),
      };
      await this.db.objections.add(o);
      ids.push(o.id);
    }
    for (const input of reviews) {
      const o = requireValue(await this.db.objections.get(input.objectionId), '争议不存在');
      if (o.discussionId !== message.discussionId)
        throw new CouncilError('CROSS_TASK_OBJECTION', '不能处理其他任务的争议');
      const relevant = [...new Set([o.sourceParticipantId, ...o.targetParticipantIds])];
      if (!relevant.includes(message.participantId))
        throw new CouncilError('UNRELATED_REVIEW', '只有争议相关成员可提交解决意见');
      if (o.status === 'resolved') continue;
      if (o.severity !== 'minor' && input.reason.trim().length < 12)
        throw new CouncilError(
          'INSUFFICIENT_REASON',
          '重大争议的撤回或解决必须附具体理由（至少 12 字符）',
        );
      const claim = requireValue(await this.db.claims.get(o.relatedClaimId), '结论不存在');
      if (input.action === 'withdraw' && message.participantId !== o.sourceParticipantId)
        throw new CouncilError('WITHDRAW_FORBIDDEN', '只有原提出者可以撤回争议');
      const review = {
        participantId: message.participantId,
        action: input.action,
        reason: input.reason,
        messageId: message.id,
        claimVersion: claim.version,
      };
      const next = [...o.reviews.filter((r) => r.participantId !== message.participantId), review];
      const allAccepted =
        claim.version > o.claimVersion &&
        relevant.every((id) =>
          next.some(
            (r) =>
              r.participantId === id &&
              r.action === 'accept_revision' &&
              r.claimVersion === claim.version,
          ),
        );
      const resolved = input.action === 'withdraw' || allAccepted;
      await this.db.objections.update(o.id, {
        reviews: next,
        status: resolved ? 'resolved' : input.action === 'reject' ? 'disputed' : 'responding',
        ...(resolved
          ? {
              resolution: next
                .map((r) => `${r.participantId}: ${r.reason} [${r.messageId}]`)
                .join('\n'),
              resolvedAt: Date.now(),
            }
          : {}),
      });
      ids.push(o.id);
    }
    return ids;
  }
}
