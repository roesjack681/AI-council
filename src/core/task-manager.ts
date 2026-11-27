import type { CouncilDB } from '../database/db';
import { discussionInputSchema, type Discussion, type DiscussionStatus } from '../protocols/domain';
import { newId } from '../utils/id';
import { CouncilError, requireValue } from '../utils/errors';
import { log } from '../utils/logger';

export const terminal = (status: DiscussionStatus): boolean =>
  ['COMPLETED', 'UNRESOLVED', 'FAILED'].includes(status);
const transitions: Record<DiscussionStatus, readonly DiscussionStatus[]> = {
  CREATED: ['INITIALIZING', 'PAUSED', 'UNRESOLVED', 'FAILED'],
  INITIALIZING: ['INITIAL_ANSWERS', 'PAUSED', 'FAILED', 'UNRESOLVED'],
  INITIAL_ANSWERS: ['FREE_DISCUSSION', 'FINALIZING', 'PAUSED', 'FAILED', 'UNRESOLVED'],
  FREE_DISCUSSION: ['OBJECTION_REVIEW', 'PAUSED', 'FAILED', 'UNRESOLVED'],
  OBJECTION_REVIEW: ['CONSENSUS_CHECK', 'PAUSED', 'FAILED', 'UNRESOLVED'],
  CONSENSUS_CHECK: ['FREE_DISCUSSION', 'FINALIZING', 'UNRESOLVED', 'PAUSED', 'FAILED'],
  FINALIZING: ['COMPLETED', 'PAUSED', 'FAILED'],
  COMPLETED: [],
  UNRESOLVED: [],
  FAILED: [],
  PAUSED: [
    'CREATED',
    'INITIALIZING',
    'INITIAL_ANSWERS',
    'FREE_DISCUSSION',
    'OBJECTION_REVIEW',
    'CONSENSUS_CHECK',
    'FINALIZING',
    'UNRESOLVED',
    'FAILED',
  ],
};
export class TaskManager {
  constructor(private readonly db: CouncilDB) {}
  async create(input: unknown): Promise<Discussion> {
    const data = discussionInputSchema.parse(input);
    const now = Date.now();
    return this.db.transaction(
      'rw',
      [this.db.discussions, this.db.participants, this.db.logs],
      async () => {
        const participantSnapshots: NonNullable<Discussion['participantSnapshots']> = [];
        for (const id of data.participantIds) {
          const p = await this.db.participants.get(id);
          if (!p?.enabled)
            throw new CouncilError('INVALID_PARTICIPANT', '所有参与者必须存在且已启用');
          if ((p.role ?? 'council') === 'brain')
            throw new CouncilError('BRAIN_NOT_DISCUSSANT', '大脑不能加入讨论');
          participantSnapshots.push({
            id: p.id,
            name: p.name,
            platform: p.platform,
            adapterId: p.adapterId,
            adapterVersion: p.adapterVersion,
          });
        }
        const task: Discussion = {
          ...data,
          participantSnapshots,
          id: newId(),
          mode: data.mode ?? 'free',
          status: 'CREATED',
          currentRound: 0,
          noProgressRounds: 0,
          lastProgressFingerprint: '',
          createdAt: now,
          updatedAt: now,
        };
        await this.db.discussions.add(task);
        await log(this.db, 'info', 'TASK_CREATED', task.id, task.id);
        return task;
      },
    );
  }
  async transition(id: string, status: DiscussionStatus, reason?: string): Promise<void> {
    await this.db.transaction('rw', [this.db.discussions, this.db.logs], async () => {
      const d = requireValue(await this.db.discussions.get(id), '任务不存在');
      if (d.status === status) return;
      if (!transitions[d.status].includes(status))
        throw new CouncilError('INVALID_TRANSITION', `${d.status} 不能转为 ${status}`);
      await this.db.discussions.update(id, {
        status,
        reason,
        reasonDetail: undefined,
        updatedAt: Date.now(),
        ...(status === 'PAUSED' ? { resumeStatus: d.status } : {}),
        ...(terminal(status) ? { finishedAt: Date.now() } : {}),
      });
      await log(
        this.db,
        status === 'FAILED' ? 'error' : 'info',
        'TASK_STATE',
        `${d.status} → ${status}; ${reason ?? ''}`,
        id,
      );
    });
  }
  async pause(id: string, reason = 'USER_PAUSED', reasonDetail?: string): Promise<void> {
    await this.db.transaction('rw', [this.db.discussions, this.db.logs], async () => {
      await this.transition(id, 'PAUSED', reason);
      await this.db.discussions.update(id, { reason, reasonDetail, updatedAt: Date.now() });
      if (reasonDetail) await log(this.db, 'warn', 'PAUSE_DETAIL', reason, id);
    });
  }
  async resume(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.tables, async () => {
      const d = requireValue(await this.db.discussions.get(id), '任务不存在');
      if (d.status !== 'PAUSED') throw new CouncilError('NOT_PAUSED', '任务未暂停');
      for (const t of await this.db.task_queue.where('discussionId').equals(id).toArray()) {
        if (t.status === 'pending') {
          await this.db.task_queue.update(t.id, {
            preflightDeadline: undefined,
            nextRetryAt: Date.now(),
            leaseUntil: 0,
            updatedAt: Date.now(),
          });
          continue;
        }
        if (t.status === 'waiting' || t.status === 'sending') {
          await this.db.task_queue.update(t.id, {
            nextRetryAt: Date.now(),
            leaseUntil: 0,
            confirmationAttempts: 0,
            ...(t.status === 'waiting' ? { startedAt: Date.now() } : {}),
            updatedAt: Date.now(),
          });
          continue;
        }
        if (t.status !== 'failed') continue;
        if (!t.receiptId && !t.lastError?.startsWith('SAFE_SEND_FAILED:'))
          throw new CouncilError('UNSAFE_RETRY', '无法确认失败请求是否已发送，禁止重新提交');
        await this.db.task_queue.update(t.id, {
          status: t.receiptId ? 'waiting' : 'pending',
          retryCount: 0,
          nextRetryAt: Date.now(),
          startedAt: Date.now(),
          leaseUntil: 0,
          updatedAt: Date.now(),
        });
        await this.db.messages.update(t.messageId, {
          status: t.receiptId ? 'delivered' : 'pending',
        });
      }
      await this.transition(id, d.resumeStatus ?? 'CREATED', 'RESUMED');
    });
  }
  async stop(id: string): Promise<void> {
    await this.transition(id, 'UNRESOLVED', 'USER_STOPPED');
  }
  async delete(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.tables, async () => {
      const d = requireValue(await this.db.discussions.get(id), '任务不存在');
      if (!terminal(d.status) && d.status !== 'PAUSED' && d.status !== 'CREATED')
        throw new CouncilError('TASK_ACTIVE', '请先停止或暂停任务');
      for (const table of this.db.tables) {
        if (
          table.name !== 'participants' &&
          table.name !== 'discussions' &&
          table.name !== 'leases'
        )
          await table.where('discussionId').equals(id).delete();
      }
      await this.db.discussions.delete(id);
    });
  }
}
