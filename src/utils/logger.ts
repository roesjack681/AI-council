import type { CouncilDB } from '../database/db';
import type { AuditLog } from '../protocols/domain';
import { newId } from './id';
// Audit details are controlled codes/IDs, never a raw exception, page content, credentials or prompts.
export async function log(
  db: CouncilDB,
  level: AuditLog['level'],
  code: string,
  detail: string,
  discussionId?: string,
): Promise<void> {
  await db.logs.add({ id: newId(), level, code, detail, discussionId, createdAt: Date.now() });
}
