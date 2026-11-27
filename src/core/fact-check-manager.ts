import { z } from 'zod';
import type { CouncilDB } from '../database/db';
import { factInputSchema, type FactCheck } from '../protocols/domain';
import { newId } from '../utils/id';
import { CouncilError, requireValue } from '../utils/errors';
import { log } from '../utils/logger';
export const calculationSchema = z
  .object({
    discussionId: z.string().min(1),
    claimId: z.string().min(1),
    operation: z.enum(['sum', 'product']),
    operands: z.array(z.number().finite()).min(1).max(100),
    expected: z.number().finite(),
  })
  .strict();
export class FactCheckManager {
  constructor(private readonly db: CouncilDB) {}
  async record(input: unknown): Promise<FactCheck> {
    const data = factInputSchema.parse(input);
    return this.save({ ...data, provenance: 'user_document' });
  }
  async calculate(input: unknown): Promise<FactCheck> {
    const data = calculationSchema.parse(input);
    const result = data.operands.reduce(
      (a, b) => (data.operation === 'sum' ? a + b : a * b),
      data.operation === 'sum' ? 0 : 1,
    );
    if (!Number.isFinite(result))
      throw new CouncilError('CALCULATION_OVERFLOW', '计算结果超出有限数值范围');
    return this.save({
      discussionId: data.discussionId,
      claimId: data.claimId,
      evidenceSource: 'local calculation (IEEE 754)',
      evidenceDescription: `${data.operation}(${data.operands.join(', ')}) = ${result}; expected ${data.expected}。只验证该算式，不验证输入对应的外部事实。`,
      verificationStatus:
        Math.abs(result - data.expected) <=
        Number.EPSILON * Math.max(1, Math.abs(result)) * data.operands.length
          ? 'VERIFIED'
          : 'CONTRADICTED',
      provenance: 'local_calculation',
      calculation: { operation: data.operation, operands: data.operands, result },
    });
  }
  private async save(
    input: Omit<FactCheck, 'id' | 'claimVersion' | 'verifiedAt'>,
  ): Promise<FactCheck> {
    return this.db.transaction(
      'rw',
      [this.db.discussions, this.db.claims, this.db.fact_checks, this.db.logs],
      async () => {
        const claim = requireValue(await this.db.claims.get(input.claimId), '结论不存在');
        const d = requireValue(await this.db.discussions.get(input.discussionId), '任务不存在');
        if (['COMPLETED', 'UNRESOLVED', 'FAILED', 'FINALIZING'].includes(d.status))
          throw new CouncilError('TASK_FROZEN', '已结束任务的证据不可修改');
        if (claim.discussionId !== input.discussionId)
          throw new CouncilError('CROSS_TASK_FACT', '证据与结论必须属于同一任务');
        if (
          input.verificationStatus === 'NOT_APPLICABLE' &&
          ['fact', 'calculation'].includes(claim.category)
        )
          throw new CouncilError('FACT_NEEDS_VERIFICATION', '事实或计算结论不能以不适用替代核验');
        const existing = await this.db.fact_checks.where('claimId').equals(claim.id).toArray();
        const fact: FactCheck = {
          ...input,
          id: newId(),
          claimVersion: claim.version,
          verifiedAt: Math.max(Date.now(), ...existing.map((f) => f.verifiedAt + 1)),
        };
        await this.db.fact_checks.add(fact);
        await log(
          this.db,
          'info',
          'EVIDENCE_RECORDED',
          `${fact.id}: ${fact.verificationStatus}`,
          fact.discussionId,
        );
        return fact;
      },
    );
  }
}
