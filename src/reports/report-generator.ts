import type { CouncilDB } from '../database/db';
import type { StoredReport } from '../protocols/domain';
import { requireValue } from '../utils/errors';
import { newId } from '../utils/id';
export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
export class ReportGenerator {
  constructor(private readonly db: CouncilDB) {}
  async generate(id: string): Promise<StoredReport> {
    const snapshot = await this.db.snapshot();
    const d = requireValue(
      snapshot.discussions.find((x) => x.id === id),
      '任务不存在',
    );
    const scoped = <T extends { discussionId?: string }>(items: T[]): T[] =>
      items.filter((x) => x.discussionId === id);
    const participants = d.participantIds
      .map(
        (pid) =>
          snapshot.participants.find((p) => p.id === pid) ??
          d.participantSnapshots?.find((p) => p.id === pid),
      )
      .filter((p) => p !== undefined);
    const messages = scoped(snapshot.messages).sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
    const claims = scoped(snapshot.claims),
      objections = scoped(snapshot.objections),
      positions = scoped(snapshot.positions),
      facts = scoped(snapshot.factChecks),
      consensus = scoped(snapshot.consensusRecords).sort((a, b) => a.roundNumber - b.roundNumber);
    const name = (pid: string) => participants.find((p) => p.id === pid)?.name ?? pid;
    const text = (values: string[]): string =>
      values.length ? values.join('\n\n') : '无已记录内容。';
    const latest = consensus.at(-1);
    const accepted = claims.filter(
      (c) =>
        c.status === 'active' &&
        d.participantIds.every((pid) =>
          positions.some(
            (p) =>
              p.participantId === pid &&
              p.claimId === c.id &&
              p.claimVersion === c.version &&
              p.final &&
              p.roundNumber === d.currentRound &&
              p.position === 'AGREE',
          ),
        ),
    );
    const markdown = [
      `# ${d.title}`,
      `> AI 生成内容记录。模型一致不等于事实正确；本报告只整理已保存记录，不生成额外模型意见。`,
      `共识要求：${(d.verificationPolicy ?? 'independent_evidence') === 'discussion_only' ? '讨论意见一致，未核实事实仍单独列明' : '关键事实须有独立核验证据'}。${latest?.warnings?.join('；') ?? ''}`,
      `## 基本信息\n\n任务 ID：${d.id}\n\n原始问题：${d.originalQuestion}\n\n背景：${d.context}\n\n约束：${d.constraints.join('；')}\n\n期望结果：${d.expectedOutput}\n\n参与模型：${d.participantIds.map(name).join('、')}\n\n开始：${new Date(d.createdAt).toISOString()}\n\n结束：${d.finishedAt ? new Date(d.finishedAt).toISOString() : '未结束'}\n\n轮次：${d.currentRound} / ${d.maxRounds}\n\n状态：${d.status}；原因：${d.reason ?? '无'}`,
      `## 初始方案\n\n${text(messages.filter((m) => m.direction === 'inbound' && snapshot.rounds.some((r) => r.id === m.roundId && r.kind === 'initial')).map((m) => `### ${name(m.participantId)}\n\n${m.structuredData?.content ?? m.content}\n\n来源：${m.id}；解析：${m.parseStatus}`))}`,
      `## 关键争议\n\n${text(objections.map((o) => `### ${o.title} [${o.id}]\n\n${o.description}\n\n提出：${name(o.sourceParticipantId)}；对象：${o.targetParticipantIds.map(name).join('、')}；严重性：${o.severity}；状态：${o.status}\n\n来源：${o.sourceMessageId}；结论：${o.relatedClaimId}\n\n回应：${o.reviews.map((r) => `${name(r.participantId)}: ${r.reason} [${r.messageId}]`).join('\n')}\n\n解决方式：${o.resolution ?? '尚未解决'}`))}`,
      `## 最终方案（按结论整理）\n\n${d.mode === 'direct' ? '点名任务：已记录目标成员回复，未进行多成员共识判断。' : d.status === 'COMPLETED' ? '确定性讨论共识规则已通过；事实核验状态见证据部分。' : '任务尚未取得完整共识；以下只是当前结论。'}\n\n${text(claims.map((c) => `${c.id} v${c.version}：${c.description}\n\n类别：${c.category}；关键：${c.critical}；来源：${c.sourceMessageId}`))}`,
      `## 共识情况\n\n全体认可：${text(accepted.map((c) => c.id))}\n\n有条件认可：${text(positions.filter((p) => p.position === 'CONDITIONAL').map((p) => `${name(p.participantId)} 对 ${p.claimId} v${p.claimVersion}：${p.reason}；条件：${p.conditions.map((c) => `${c.description} [${c.evidenceIds.join(',')}]`).join('；')}；来源 ${p.sourceMessageId}`))}\n\n未解决争议：${text(objections.filter((o) => o.status !== 'resolved').map((o) => `${o.id}: ${o.description}`))}\n\n最新判断：${latest ? JSON.stringify({ reached: latest.reached, stableRounds: latest.stableRounds, reasons: latest.reasons }) : '尚无共识检查'}\n\n最终风险：${text([...(latest?.reasons ?? []), ...claims.filter((c) => c.category === 'assumption' || c.category === 'unverified').map((c) => `${c.id}: ${c.category}`)])}`,
      `## 事实与证据\n\n${text(facts.map((f) => `${f.claimId} v${f.claimVersion}: ${f.verificationStatus}\n\n${f.evidenceDescription}\n\n来源：${f.evidenceSource}；记录者类别：${f.provenance}；证据 ID：${f.id}`))}\n\n未记录证据的事实不代表已核实。用户文档核验代表用户声明，本地计算只验证算式。`,
      `## 完整讨论记录\n\n${text(messages.map((m) => `### ${name(m.participantId)} / ${m.direction} / ${m.type}\n\n消息：${m.id}；轮次：${m.roundId}；关联请求：${m.replyTo ?? '无'}；状态：${m.status}；解析：${m.parseStatus}\n\n${m.content}`))}`,
    ].join('\n\n');
    const json = JSON.stringify(
      {
        formatVersion: 1,
        discussion: d,
        participants,
        messages,
        rounds: scoped(snapshot.rounds),
        claims,
        claimRevisions: scoped(snapshot.claimRevisions),
        positions,
        objections,
        factChecks: facts,
        consensusRecords: consensus,
        queue: scoped(snapshot.queue),
        browserSessions: scoped(snapshot.browserSessions),
        browserDeliveries: scoped(snapshot.browserDeliveries),
        recoveredDrafts: scoped(snapshot.recoveredDrafts ?? []),
        logs: await this.db.logs.where('discussionId').equals(id).toArray(),
      },
      null,
      2,
    );
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(d.title)}</title><style>body{max-width:960px;margin:40px auto;padding:20px;font:16px/1.7 system-ui;color:#172c3f;background:#fbfcff}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><pre>${escapeHtml(markdown)}</pre></body></html>`;
    const old = await this.db.reports.where('discussionId').equals(id).first();
    const report: StoredReport = {
      id: old?.id ?? newId(),
      discussionId: id,
      status: d.status,
      markdown,
      html,
      json,
      createdAt: Date.now(),
    };
    await this.db.reports.put(report);
    return report;
  }
}
