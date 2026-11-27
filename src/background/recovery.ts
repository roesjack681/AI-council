import type { CouncilDB } from '../database/db';
import { ComplianceGate } from '../adapters/base/compliance-gate';
import { TaskManager, terminal } from '../core/task-manager';
import { CouncilError } from '../utils/errors';
import { log } from '../utils/logger';
import { RequestCoordinator } from '../core/request-coordinator';
import { isPagePreparationPending } from '../core/page-readiness';
export async function recover(db: CouncilDB, gate: ComplianceGate): Promise<void> {
  for (const discussion of await db.discussions.toArray()) {
    if (terminal(discussion.status) || discussion.status === 'CREATED') continue;
    if (discussion.status === 'PAUSED') {
      if (
        discussion.reason !== 'DRAFT_PRESENT' ||
        !discussion.userRequestId ||
        !(await new RequestCoordinator(db).isCurrent(discussion.userRequestId))
      )
        continue;
      const queue = await db.task_queue.where('discussionId').equals(discussion.id).toArray();
      if (
        queue.some((task) => ['sending', 'waiting'].includes(task.status) || task.receiptId) ||
        !['CREATED', 'INITIALIZING', 'INITIAL_ANSWERS'].includes(discussion.resumeStatus ?? '')
      )
        continue;
      try {
        for (const id of discussion.participantIds)
          await gate.requireReady(id, 'initial', discussion.id);
        await new TaskManager(db).resume(discussion.id);
        if (discussion.resumeStatus === 'CREATED')
          await new TaskManager(db).transition(discussion.id, 'INITIALIZING');
        await db.discussions.update(discussion.id, { startup: undefined });
        await log(db, 'info', 'CURRENT_TASK_DRAFT_RECOVERED', discussion.id, discussion.id);
      } catch {
        await log(db, 'warn', 'DRAFT_RECOVERY_PENDING', discussion.id, discussion.id);
      }
      continue;
    }
    if (!(await new RequestCoordinator(db).isCurrent(discussion.userRequestId))) {
      await new TaskManager(db).pause(
        discussion.id,
        'REQUEST_SUPERSEDED',
        '此题已被新问题替代，重启不会自动恢复旧题。',
      );
      continue;
    }
    try {
      const queue = await db.task_queue.where('discussionId').equals(discussion.id).toArray();
      for (const id of discussion.participantIds) {
        const outstanding = queue.filter(
          (task) => task.participantId === id && !['done', 'failed'].includes(task.status),
        );
        if (
          outstanding.length &&
          (await Promise.all(outstanding.map((task) => gate.cachedResponse(task)))).every(Boolean)
        )
          continue;
        const awaiting = queue.some(
          (task) => task.participantId === id && ['waiting', 'sending'].includes(task.status),
        );
        await gate.requireReady(
          id,
          awaiting
            ? 'observe'
            : ['INITIALIZING', 'INITIAL_ANSWERS'].includes(discussion.status)
              ? 'initial'
              : 'verified',
          discussion.id,
        );
      }
      await log(db, 'info', 'TASK_RECOVERED', discussion.id, discussion.id);
    } catch (error) {
      if (
        error instanceof CouncilError &&
        isPagePreparationPending(error.code) &&
        ['INITIALIZING', 'INITIAL_ANSWERS'].includes(discussion.status)
      ) {
        await log(db, 'info', 'RECOVERY_WAITING_FOR_PAGE', error.code, discussion.id);
        continue;
      }
      await new TaskManager(db).pause(
        discussion.id,
        error instanceof CouncilError ? error.code : 'RECOVERY_FAILED',
      );
      await log(db, 'warn', 'RECOVERY_PAUSED', discussion.id, discussion.id);
    }
  }
  // sending records stay sending and must reconcile after lease expiry. Never reset them to pending.
}
