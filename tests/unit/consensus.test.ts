import { describe, it, expect } from 'vitest';
import { evaluateConsensus, type ConsensusInput } from '../../src/core/consensus-engine';
import type { Discussion, Claim, Position, Objection, FactCheck } from '../../src/protocols/domain';
const discussion: Discussion = {
  id: 'd',
  title: 'test',
  originalQuestion: 'test',
  context: '',
  constraints: [],
  expectedOutput: '',
  participantIds: ['a', 'b'],
  mode: 'free',
  maxRounds: 10,
  currentRound: 1,
  noProgressRounds: 0,
  lastProgressFingerprint: '',
  status: 'CONSENSUS_CHECK',
  stableRoundsRequired: 2,
  timeoutMs: 1000,
  maxRetries: 2,
  privacyAcknowledged: true,
  createdAt: 1,
  updatedAt: 1,
};
const claim: Claim = {
  id: 'c',
  discussionId: 'd',
  ownerId: 'a',
  key: 'test',
  description: 'TEST CLAIM',
  category: 'recommendation',
  critical: true,
  version: 1,
  status: 'active',
  sourceMessageId: 'm',
  createdAt: 1,
  updatedAt: 1,
};
const positions: Position[] = discussion.participantIds.map((id) => ({
  id,
  discussionId: 'd',
  participantId: id,
  claimId: 'c',
  claimVersion: 1,
  position: 'AGREE',
  reason: 'Test specific supporting evidence',
  final: true,
  conditions: [],
  sourceMessageId: `m-${id}`,
  roundNumber: 1,
  createdAt: 1,
}));
const base = (): ConsensusInput =>
  structuredClone({ discussion, claims: [claim], positions, objections: [], facts: [] });
const objection = (severity: Objection['severity']): Objection => ({
  id: 'o',
  discussionId: 'd',
  title: 'TEST',
  description: 'TEST',
  sourceParticipantId: 'b',
  targetParticipantIds: ['a'],
  relatedClaimId: 'c',
  claimVersion: 1,
  severity,
  status: 'open',
  evidence: [],
  reviews: [],
  sourceMessageId: 'mo',
  createdAt: 1,
});
const fact = (verificationStatus: FactCheck['verificationStatus'] = 'VERIFIED'): FactCheck => ({
  id: 'f',
  discussionId: 'd',
  claimId: 'c',
  claimVersion: 1,
  evidenceSource: 'TEST DOCUMENT',
  evidenceDescription: 'TEST EVIDENCE',
  verificationStatus,
  provenance: 'user_document',
  verifiedAt: 1,
});
describe('strict deterministic consensus', () => {
  it('T01 requires two distinct rounds with new final positions, never two calls', async () => {
    const input = base();
    const first = await evaluateConsensus(input);
    expect(first.reached).toBe(false);
    expect(first.stableRounds).toBe(1);
    expect((await evaluateConsensus({ ...input, previous: first })).stableRounds).toBe(1);
    input.discussion.currentRound = 2;
    input.positions.forEach((p) => (p.roundNumber = 2));
    expect((await evaluateConsensus({ ...input, previous: first })).reached).toBe(true);
  });
  it('reaches on the first eligible round when only one stable round is required', async () => {
    const input = base();
    input.discussion.stableRoundsRequired = 1;
    const first = await evaluateConsensus(input);
    expect(first.stableRounds).toBe(1);
    expect(first.reached).toBe(true);
  });
  it.each(['DISAGREE', 'UNCERTAIN', 'ABSTAIN'] as const)(
    'T02 blocks %s instead of majority vote',
    async (position) => {
      const input = base();
      input.positions[1]!.position = position;
      expect((await evaluateConsensus(input)).coreClaimsAccepted).toBe(false);
    },
  );
  it('rejects missing, stale and nonfinal positions', async () => {
    for (const mutate of [
      (p: Position) => (p.claimVersion = 0),
      (p: Position) => (p.final = false),
      (p: Position) => (p.roundNumber = 0),
    ]) {
      const input = base();
      mutate(input.positions[1]!);
      expect((await evaluateConsensus(input)).participantCompletion).toBe(false);
    }
  });
  it('does not infer consensus without core claims', async () => {
    const input = base();
    input.claims = [];
    expect((await evaluateConsensus(input)).stableRounds).toBe(0);
  });
  it.each(['major', 'critical'] as const)('blocks an unresolved %s objection', async (severity) => {
    const input = base();
    input.objections = [objection(severity)];
    expect((await evaluateConsensus(input)).stableRounds).toBe(0);
  });
  it('discussion-only policy reports unverified facts without claiming fact verification', async () => {
    const input = base();
    input.claims[0]!.category = 'fact';
    input.discussion.verificationPolicy = 'discussion_only';
    const first = await evaluateConsensus(input);
    expect(first.unverifiedCriticalFacts).toBe(1);
    expect(first.warnings?.length).toBeGreaterThan(0);
    expect(first.stableRounds).toBe(1);
  });
  it('T11 agreement cannot verify a critical fact once facts exist', async () => {
    const input = base();
    input.claims[0]!.category = 'fact';
    input.facts = [fact('UNVERIFIED')];
    expect((await evaluateConsensus(input)).unverifiedCriticalFacts).toBe(1);
    input.facts = [fact()];
    expect((await evaluateConsensus(input)).unverifiedCriticalFacts).toBe(0);
    input.facts.push({ ...fact('CONTRADICTED'), id: 'f2', verifiedAt: 2 });
    expect((await evaluateConsensus(input)).stableRounds).toBe(0);
  });
  it('requires evidence with the strict policy even before any fact row exists', async () => {
    const input = base();
    input.claims[0]!.category = 'fact';
    input.discussion.verificationPolicy = 'independent_evidence';
    expect((await evaluateConsensus(input)).stableRounds).toBe(0);
    expect((await evaluateConsensus(input)).unverifiedCriticalFacts).toBe(1);
  });
  it('contradictory evidence blocks both policies and changing policy resets stability', async () => {
    const input = base();
    input.discussion.verificationPolicy = 'discussion_only';
    input.facts = [fact('CONTRADICTED')];
    expect((await evaluateConsensus(input)).stableRounds).toBe(0);
    input.facts = [];
    const first = await evaluateConsensus(input);
    input.discussion.currentRound++;
    input.positions.forEach((position) => position.roundNumber++);
    input.discussion.verificationPolicy = 'independent_evidence';
    expect((await evaluateConsensus({ ...input, previous: first })).stableRounds).toBe(1);
  });
  it('invalidates evidence after a claim revision', async () => {
    const input = base();
    input.claims[0]!.category = 'fact';
    input.claims[0]!.version = 2;
    input.facts = [fact()];
    expect((await evaluateConsensus(input)).unverifiedCriticalFacts).toBe(1);
  });
  it('conditional acceptance requires independently verified evidence', async () => {
    const input = base();
    input.positions[1]!.position = 'CONDITIONAL';
    input.positions[1]!.conditions = [{ description: 'TEST CONDITION', evidenceIds: [] }];
    expect((await evaluateConsensus(input)).unresolvedConditions).toBe(1);
    input.facts = [fact()];
    input.positions[1]!.conditions[0]!.evidenceIds = ['f'];
    expect((await evaluateConsensus(input)).coreClaimsAccepted).toBe(true);
  });
  it('new claim versions reset stable rounds', async () => {
    const input = base();
    const first = await evaluateConsensus(input);
    input.discussion.currentRound = 2;
    input.claims[0]!.version = 2;
    input.positions.forEach((p) => {
      p.roundNumber = 2;
      p.claimVersion = 2;
    });
    expect((await evaluateConsensus({ ...input, previous: first })).stableRounds).toBe(1);
  });
  it('foreign task positions or facts never count', async () => {
    const input = base();
    input.positions[1]!.discussionId = 'other';
    input.facts = [{ ...fact(), discussionId: 'other' }];
    expect((await evaluateConsensus(input)).participantCompletion).toBe(false);
  });
});
