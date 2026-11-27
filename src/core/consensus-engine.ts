import type {
  Discussion,
  Claim,
  Objection,
  Position,
  FactCheck,
  ConsensusRecord,
} from '../protocols/domain';
import { digest, newId } from '../utils/id';
export interface ConsensusInput {
  discussion: Discussion;
  claims: Claim[];
  objections: Objection[];
  positions: Position[];
  facts: FactCheck[];
  previous?: ConsensusRecord;
}
export async function evaluateConsensus(input: ConsensusInput): Promise<ConsensusRecord> {
  const { discussion: d } = input;
  const claims = input.claims
    .filter((c) => c.discussionId === d.id && c.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id));
  const positions = input.positions.filter(
    (p) =>
      p.discussionId === d.id &&
      d.participantIds.includes(p.participantId) &&
      claims.some((c) => c.id === p.claimId && c.version === p.claimVersion),
  );
  const objections = input.objections.filter(
    (o) => o.discussionId === d.id && o.status !== 'resolved',
  );
  const facts = input.facts.filter(
    (f) =>
      f.discussionId === d.id &&
      claims.some((c) => c.id === f.claimId && c.version === f.claimVersion),
  );
  const latestFact = (claimId: string) =>
    facts.filter((f) => f.claimId === claimId).sort((a, b) => b.verifiedAt - a.verifiedAt)[0];
  const conditionSatisfied = (ids: string[]): boolean =>
    ids.length > 0 &&
    ids.every((id) => {
      const f = facts.find((x) => x.id === id);
      return (
        f?.verificationStatus === 'VERIFIED' &&
        latestFact(f.claimId)?.verificationStatus === 'VERIFIED'
      );
    });
  const participantCompletion =
    claims.length > 0 &&
    d.participantIds.every((id) =>
      claims.every((c) =>
        positions.some(
          (p) =>
            p.participantId === id &&
            p.claimId === c.id &&
            p.final &&
            p.roundNumber === d.currentRound,
        ),
      ),
    );
  const unresolvedConditions = positions.reduce(
    (n, p) => n + p.conditions.filter((c) => !conditionSatisfied(c.evidenceIds)).length,
    0,
  );
  const coreClaimsAccepted =
    claims.length > 0 &&
    d.participantIds.every((id) =>
      claims.every((c) =>
        positions.some(
          (p) =>
            p.participantId === id &&
            p.claimId === c.id &&
            p.reason.trim().length >= 8 &&
            ((p.position === 'AGREE' && p.conditions.length === 0) ||
              (p.position === 'CONDITIONAL' &&
                p.conditions.length > 0 &&
                p.conditions.every((x) => conditionSatisfied(x.evidenceIds)))),
        ),
      ),
    );
  // A task policy, never inferred from whether someone happened to add an evidence row.
  const verificationPolicy = d.verificationPolicy ?? 'independent_evidence';
  const unverifiedFacts = claims
    .filter(
      (c) =>
        (c.critical &&
          ['fact', 'calculation', 'unverified'].includes(c.category) &&
          latestFact(c.id)?.verificationStatus !== 'VERIFIED') ||
        latestFact(c.id)?.verificationStatus === 'CONTRADICTED',
    )
    .map((c) => c.id);
  const contradicted = claims.some(
    (claim) => latestFact(claim.id)?.verificationStatus === 'CONTRADICTED',
  );
  const major = objections.filter((o) => o.severity === 'major').length,
    critical = objections.filter((o) => o.severity === 'critical').length;
  const eligible =
    participantCompletion &&
    coreClaimsAccepted &&
    major === 0 &&
    critical === 0 &&
    unresolvedConditions === 0 &&
    !contradicted &&
    (verificationPolicy === 'discussion_only' || unverifiedFacts.length === 0);
  const fingerprint = await digest(
    JSON.stringify({
      participants: [...d.participantIds].sort(),
      verificationPolicy,
      claims: claims.map((c) => [c.id, c.version, c.description, c.category, c.critical]),
      positions: positions
        .map((p) => [p.participantId, p.claimId, p.claimVersion, p.position, p.final, p.conditions])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      objections: objections.map((o) => [o.id, o.status, o.severity]).sort(),
      facts: facts.map((f) => [f.id, f.verificationStatus]).sort(),
    }),
  );
  const previous = input.previous;
  const stableRounds = eligible
    ? previous &&
      previous.roundNumber === d.currentRound - 1 &&
      previous.fingerprint === fingerprint &&
      previous.stableRounds > 0
      ? previous.stableRounds + 1
      : 1
    : 0;
  const reasons: string[] = [];
  if (!participantCompletion) reasons.push('缺少本轮全体成员对每项当前版本结论的最终表态');
  if (!coreClaimsAccepted) reasons.push('核心结论尚未获得全体成员有依据的认可');
  if (major + critical > 0) reasons.push(`存在 ${major} 项重大、${critical} 项关键争议`);
  if (unresolvedConditions) reasons.push('有条件认可的条件缺少独立核验证据');
  if (contradicted || (verificationPolicy === 'independent_evidence' && unverifiedFacts.length))
    reasons.push('存在关键事实未核实或证据矛盾');
  if (eligible && stableRounds < d.stableRoundsRequired)
    reasons.push('需要新一轮独立表态确认稳定共识');
  return {
    verificationPolicy,
    warnings: unverifiedFacts.length ? ['讨论一致不代表事实核验；仍有关键事实未获独立验证'] : [],
    id: newId(),
    discussionId: d.id,
    roundNumber: d.currentRound,
    reached: eligible && stableRounds >= d.stableRoundsRequired,
    participantCompletion,
    coreClaimsAccepted,
    unresolvedMajorObjections: major,
    unresolvedCriticalObjections: critical,
    unresolvedConditions,
    unverifiedCriticalFacts: unverifiedFacts.length,
    stableRounds,
    reasons,
    fingerprint,
    participantPositions: positions,
    unresolvedObjections: objections.map((o) => o.id),
    unverifiedFacts,
    checkedAt: Date.now(),
  };
}
