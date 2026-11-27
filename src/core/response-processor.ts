import type { CouncilDB } from '../database/db';
import {
  responseSchema,
  type DiscussionMessage,
  type QueueTask,
  type Position,
} from '../protocols/domain';
import { ClaimManager } from './claim-manager';
import { ObjectionEngine } from './objection-engine';
import { CouncilError, requireValue } from '../utils/errors';
import { log } from '../utils/logger';
export class ResponseProcessor {
  constructor(private readonly db: CouncilDB) {}
  private async reject(message: DiscussionMessage, code: string, detail: string): Promise<false> {
    await this.db.transaction('rw', [this.db.messages, this.db.logs], async () => {
      await this.db.messages.update(message.id, {
        parseStatus: 'PARSE_FAILED',
        parseError: { code, detail },
      });
      await log(this.db, 'warn', code, message.id, message.discussionId);
    });
    return false;
  }
  async process(message: DiscussionMessage, task: QueueTask): Promise<boolean> {
    if (
      message.discussionId !== task.discussionId ||
      message.participantId !== task.participantId ||
      message.replyTo !== task.messageId
    )
      throw new CouncilError('CROSS_TASK_RESPONSE', '响应与请求归属不一致');
    if ((await this.db.messages.get(message.id))?.parseStatus === 'valid') return true;
    let parsed: unknown;
    try {
      const text = message.content
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, '');
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        const start = text.indexOf('{'),
          end = text.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('NO_JSON_PROTOCOL');
        parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      }
    } catch {
      return this.reject(message, 'INVALID_JSON', '未找到完整可解析的 JSON 对象');
    }
    const result = responseSchema.safeParse(parsed);
    if (!result.success) {
      return this.reject(
        message,
        'INVALID_PROTOCOL',
        result.error.issues
          .slice(0, 12)
          .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
          .join('；'),
      );
    }
    try {
      await this.db.transaction('rw', this.db.tables, async () => {
        const current = requireValue(
          await this.db.discussions.get(message.discussionId),
          '任务不存在',
        );
        if (!current.participantIds.includes(message.participantId))
          throw new CouncilError('INVALID_AUTHOR', '模型不属于该任务');
        const claimIds = await new ClaimManager(this.db).apply(message, result.data.claims);
        const round = requireValue(await this.db.rounds.get(task.roundId), '轮次不存在');
        for (const input of result.data.positions) {
          const claim = requireValue(
            await this.db.claims.get(input.claimId),
            '立场引用不存在的结论',
          );
          if (claim.discussionId !== message.discussionId || claim.version !== input.version)
            throw new CouncilError('STALE_POSITION', '立场必须引用本任务当前版本结论');
          if (input.position === 'CONDITIONAL' && input.conditions.length === 0)
            throw new CouncilError('EMPTY_CONDITIONS', '有条件认可必须说明条件');
          if (input.position === 'AGREE' && input.conditions.length > 0)
            throw new CouncilError('HIDDEN_CONDITIONS', '带条件的认可必须标记 CONDITIONAL');
          for (const condition of input.conditions)
            for (const evidenceId of condition.evidenceIds) {
              const fact = await this.db.fact_checks.get(evidenceId);
              if (!fact || fact.discussionId !== message.discussionId)
                throw new CouncilError('INVALID_EVIDENCE', '条件引用了其他任务或不存在的证据');
            }
          const position: Position = {
            id: `${current.id}:${message.participantId}:${claim.id}`,
            discussionId: current.id,
            participantId: message.participantId,
            claimId: claim.id,
            claimVersion: claim.version,
            position: input.position,
            reason: input.reason,
            final: input.final,
            conditions: input.conditions,
            sourceMessageId: message.id,
            roundNumber: round.roundNumber,
            createdAt: Date.now(),
          };
          await this.db.positions.put(position);
        }
        const objectionIds = await new ObjectionEngine(this.db).apply(
          message,
          result.data.objections,
          result.data.resolutions,
        );
        await this.db.messages.update(message.id, {
          parseStatus: 'valid',
          parseError: undefined,
          structuredData: result.data,
          type: result.data.type,
          relatedClaimIds: [
            ...new Set([...claimIds, ...result.data.positions.map((p) => p.claimId)]),
          ],
          relatedObjectionIds: objectionIds,
        });
        await log(this.db, 'info', 'RESPONSE_APPLIED', message.id, message.discussionId);
      });
      return true;
    } catch (error) {
      if (error instanceof CouncilError) return this.reject(message, error.code, error.message);
      await log(
        this.db,
        'warn',
        error instanceof CouncilError ? error.code : 'RESPONSE_APPLY_FAILED',
        message.id,
        message.discussionId,
      );
      throw error;
    }
  }
}
