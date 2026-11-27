import type { CouncilDB } from '../database/db';
import type {
  Claim,
  Discussion,
  DiscussionMessage,
  Objection,
  Position,
  FactCheck,
} from '../protocols/domain';
export interface PublicContext {
  task: Discussion;
  claims: Claim[];
  positions: Position[];
  objections: Objection[];
  facts: FactCheck[];
  messages: DiscussionMessage[];
  summary: string;
}
export async function buildContext(db: CouncilDB, task: Discussion): Promise<PublicContext> {
  const claims = (await db.claims.where('discussionId').equals(task.id).toArray()).filter(
    (claim) => claim.status === 'active',
  );
  const positions = (await db.positions.where('discussionId').equals(task.id).toArray()).filter(
    (position) =>
      claims.some(
        (claim) => claim.id === position.claimId && claim.version === position.claimVersion,
      ),
  );
  const objections = await db.objections.where('discussionId').equals(task.id).toArray();
  const facts = await db.fact_checks.where('discussionId').equals(task.id).toArray();
  const messages = (await db.messages.where('discussionId').equals(task.id).toArray())
    .filter((m) => m.direction === 'inbound')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const list = (values: string[]) => (values.length ? values.join('\n') : '无已记录内容');
  const summary = [
    `原始任务：${task.originalQuestion}`,
    `当前主要方案：${list(claims.map((c) => `${c.id} v${c.version}: ${c.description} [${c.sourceMessageId}]`))}`,
    `所有模型认可的观点：${list(claims.filter((c) => task.participantIds.every((id) => positions.some((p) => p.participantId === id && p.claimId === c.id && p.claimVersion === c.version && p.position === 'AGREE'))).map((c) => c.id))}`,
    `存在分歧的观点：${list(positions.filter((p) => ['DISAGREE', 'CONDITIONAL', 'UNCERTAIN'].includes(p.position)).map((p) => `${p.claimId}: ${p.participantId} ${p.position} — ${p.reason}`))}`,
    `已解决的争议：${list(objections.filter((o) => o.status === 'resolved').map((o) => `${o.id}: ${o.resolution}`))}`,
    `未解决的争议：${list(objections.filter((o) => o.status !== 'resolved').map((o) => `${o.id}: ${o.description}`))}`,
    `新增事实：${list(facts.map((f) => `${f.claimId}: ${f.verificationStatus} [${f.id}]`))}`,
    `新增假设：${list(claims.filter((c) => c.category === 'assumption').map((c) => c.description))}`,
    `方案修改记录：${list(claims.filter((c) => c.version > 1).map((c) => `${c.id} → v${c.version}`))}`,
    `下一步需要讨论的问题：${list(objections.filter((o) => o.status !== 'resolved').map((o) => o.title))}`,
  ].join('\n\n');
  return { task, claims, positions, objections, facts, messages, summary };
}
