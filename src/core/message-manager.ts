import type { CouncilDB } from '../database/db';
import Dexie from 'dexie';
import type { QueueTask, DiscussionMessage, Round } from '../protocols/domain';
import { digest, newId } from '../utils/id';
import { CouncilError } from '../utils/errors';
export class MessageManager {
  constructor(private readonly db: CouncilDB) {}
  async enqueue(
    discussionId: string,
    participantId: string,
    round: Round,
    prompt: string,
    taskType: QueueTask['taskType'],
    eventKey: string,
  ): Promise<QueueTask> {
    const key = await Dexie.waitFor(
      digest(JSON.stringify([discussionId, participantId, eventKey])),
    );
    return this.db.transaction(
      'rw',
      [this.db.messages, this.db.task_queue, this.db.discussions],
      async () => {
        const discussion = await this.db.discussions.get(discussionId);
        if (
          !discussion ||
          !discussion.participantIds.includes(participantId) ||
          round.discussionId !== discussionId
        )
          throw new CouncilError('CROSS_TASK_MESSAGE', '消息必须属于当前任务及参与者');
        const existing = await this.db.task_queue.where('dedupeKey').equals(key).first();
        if (existing) return existing;
        const now = Date.now();
        const message: DiscussionMessage = {
          id: newId(),
          dedupeKey: `out:${key}`,
          discussionId,
          participantId,
          roundId: round.id,
          direction: 'outbound',
          type: taskType === 'initial' ? 'INITIAL_ANSWER' : 'REVIEW',
          content: prompt,
          parseStatus: 'not_applicable',
          relatedClaimIds: [],
          relatedObjectionIds: [],
          status: 'pending',
          createdAt: now,
        };
        const task: QueueTask = {
          id: newId(),
          dedupeKey: key,
          discussionId,
          participantId,
          messageId: message.id,
          roundId: round.id,
          taskType,
          status: 'pending',
          retryCount: 0,
          nextRetryAt: now,
          leaseUntil: 0,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.messages.add(message);
        await this.db.task_queue.add(task);
        return task;
      },
    );
  }
  async receive(task: QueueTask, externalId: string, raw: string): Promise<DiscussionMessage> {
    if (!externalId || !raw.trim() || raw.length > 200_000)
      throw new CouncilError('INVALID_RESPONSE', '响应缺少标识、为空或超过大小限制');
    const key = `in:${await digest(JSON.stringify([task.discussionId, task.participantId, externalId]))}`;
    return this.db.transaction('rw', [this.db.messages, this.db.task_queue], async () => {
      const prior = await this.db.messages.where('dedupeKey').equals(key).first();
      if (prior && prior.replyTo !== task.messageId)
        throw new CouncilError('DUPLICATE_RESPONSE', '同一平台响应不能用于不同的请求');
      if (prior) return prior;
      const message: DiscussionMessage = {
        id: newId(),
        dedupeKey: key,
        discussionId: task.discussionId,
        participantId: task.participantId,
        roundId: task.roundId,
        direction: 'inbound',
        type: 'RESPONSE',
        content: raw,
        parseStatus: 'PARSE_FAILED',
        replyTo: task.messageId,
        relatedClaimIds: [],
        relatedObjectionIds: [],
        status: 'received',
        createdAt: Date.now(),
      };
      await this.db.messages.add(message);
      return message;
    });
  }
}
