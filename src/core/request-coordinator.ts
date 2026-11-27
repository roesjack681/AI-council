import type { CouncilDB } from '../database/db';
import { TaskManager, terminal } from './task-manager';
import { newId } from '../utils/id';
import { CouncilError } from '../utils/errors';
import { log } from '../utils/logger';

/** UI selection is never dispatch authority. The current user request is persisted independently. */
export class RequestCoordinator {
  constructor(private readonly db: CouncilDB) {}
  async begin(): Promise<string> {
    return this.db.transaction('rw', this.db.tables, async () => {
      for (const discussion of await this.db.discussions.toArray()) {
        if (!terminal(discussion.status) && !['PAUSED', 'CREATED'].includes(discussion.status))
          await new TaskManager(this.db).pause(
            discussion.id,
            'NEW_QUESTION',
            '已开始新问题；本题记录保留，未经明确恢复不会继续派发。',
          );
      }
      for (const job of await this.db.brain_requests.toArray()) {
        if (job.phase === 'done' || job.phase === 'paused' || job.phase === 'cancelled') continue;
        await this.db.brain_requests.update(job.id, {
          resumePhase: job.phase,
          phase: 'paused',
          error: { code: 'NEW_QUESTION', detail: '新问题已开始，旧路由保留但不再自动执行。' },
          updatedAt: Date.now(),
        });
      }
      const requestId = newId();
      await this.db.runtime_state.put({ id: 'foreground', requestId, updatedAt: Date.now() });
      await log(this.db, 'info', 'USER_REQUEST_STARTED', requestId);
      return requestId;
    });
  }
  async isCurrent(requestId?: string): Promise<boolean> {
    const foreground = await this.db.runtime_state.get('foreground');
    return requestId === undefined ? !foreground : foreground?.requestId === requestId;
  }
  async bind(
    requestId: string,
    target: { discussionId?: string; brainRequestId?: string },
  ): Promise<void> {
    if (!(await this.isCurrent(requestId)))
      throw new CouncilError('REQUEST_SUPERSEDED', '此请求已被新的用户问题替代，没有继续派发');
    await this.db.runtime_state.update('foreground', { ...target, updatedAt: Date.now() });
  }
  async activateDiscussion(id: string): Promise<void> {
    const discussion = await this.db.discussions.get(id);
    if (!discussion || !['CREATED', 'PAUSED'].includes(discussion.status))
      throw new CouncilError('NOT_RESUMABLE', '只能明确启动待开始或已暂停的任务');
    const requestId = await this.begin();
    await this.db.discussions.update(id, { userRequestId: requestId });
    await this.bind(requestId, { discussionId: id });
  }
  async activateBrain(id: string): Promise<void> {
    const job = await this.db.brain_requests.get(id);
    if (!job || job.phase !== 'paused')
      throw new CouncilError('NOT_PAUSED', '只能恢复已暂停的路由');
    const requestId = await this.begin();
    await this.db.brain_requests.update(id, { userRequestId: requestId });
    await this.bind(requestId, { brainRequestId: id });
  }
}
