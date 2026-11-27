import { afterEach, describe, it, expect } from 'vitest';
import { fixture, envelope, type Fixture } from '../fixtures/council';
import { MessageManager } from '../../src/core/message-manager';
import { ResponseProcessor } from '../../src/core/response-processor';
import { FactCheckManager } from '../../src/core/fact-check-manager';
import type { ModelResponse, DiscussionMessage, QueueTask } from '../../src/protocols/domain';
let f: Fixture | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
async function setup() {
  f = await fixture(3);
  const d = await f.create();
  await f.service.engine.start(d.id);
  const tasks = await f.db.task_queue.toArray();
  return { fx: f, d, tasks };
}
async function process(
  fx: Fixture,
  task: QueueTask,
  response: ModelResponse,
): Promise<DiscussionMessage> {
  const m = await new MessageManager(fx.db).receive(
    task,
    crypto.randomUUID(),
    JSON.stringify(response),
  );
  await new ResponseProcessor(fx.db).process(m, task);
  return (await fx.db.messages.get(m.id))!;
}
async function addClaim(fx: Fixture, task: QueueTask) {
  await process(
    fx,
    task,
    envelope({
      claims: [
        {
          key: 'proposal',
          description: 'TEST ORIGINAL PROPOSAL',
          category: 'fact',
          critical: true,
        },
      ],
    }),
  );
  return (await fx.db.claims.toArray())[0]!;
}
describe('claims, objections and independent evidence', () => {
  it('parses a protocol wrapped by webpage code labels while retaining the entire original response', async () => {
    const { fx, tasks } = await setup();
    const task = tasks[0]!;
    const raw = 'json\n复制代码\n' + JSON.stringify(envelope()) + '\n';
    const message = await new MessageManager(fx.db).receive(task, 'wrapped-response', raw);
    expect(await new ResponseProcessor(fx.db).process(message, task)).toBe(true);
    expect((await fx.db.messages.get(message.id))?.content).toBe(raw);
  });
  it('T03 different authors create separate traceable disputes and identical objections deduplicate', async () => {
    const { fx, tasks } = await setup();
    const c = await addClaim(fx, tasks[0]!);
    for (const task of tasks.slice(1)) {
      const objection = {
        claimId: c.id,
        title: 'TEST DISPUTE',
        description: `TEST DIFFERENT OBJECTION ${task.participantId}`,
        severity: 'major' as const,
        targetParticipantIds: [c.ownerId],
        evidence: [],
      };
      await process(fx, task, envelope({ objections: [objection, objection] }));
    }
    expect(await fx.db.objections.count()).toBe(2);
    expect((await fx.db.objections.toArray()).every((o) => o.sourceMessageId)).toBe(true);
  });
  it('T04 revisions preserve version history and stale positions never carry forward', async () => {
    const { fx, tasks } = await setup();
    const task = tasks[0]!;
    const c = await addClaim(fx, task);
    await process(
      fx,
      task,
      envelope({
        positions: [
          {
            claimId: c.id,
            version: 1,
            position: 'AGREE',
            reason: 'TEST rationale for original proposal',
            conditions: [],
            final: true,
          },
        ],
      }),
    );
    await process(
      fx,
      task,
      envelope({
        type: 'REVISION',
        claims: [
          {
            key: 'proposal',
            description: 'TEST REVISED PROPOSAL',
            category: 'fact',
            critical: true,
          },
        ],
      }),
    );
    expect((await fx.db.claims.get(c.id))?.version).toBe(2);
    expect(await fx.db.claim_revisions.count()).toBe(2);
    expect((await fx.db.positions.toArray())[0]?.claimVersion).toBe(1);
  });
  it('T05 author can withdraw with a specific reason; another model cannot', async () => {
    const { fx, tasks } = await setup();
    const c = await addClaim(fx, tasks[0]!);
    const author = tasks[1]!;
    await process(
      fx,
      author,
      envelope({
        objections: [
          {
            claimId: c.id,
            title: 'TEST DISPUTE',
            description: 'TEST OBJECTION',
            severity: 'major',
            targetParticipantIds: [c.ownerId],
            evidence: [],
          },
        ],
      }),
    );
    const o = (await fx.db.objections.toArray())[0]!;
    const unauthorized = await process(
      fx,
      tasks[0]!,
      envelope({
        resolutions: [
          {
            objectionId: o.id,
            action: 'withdraw',
            reason: 'TEST reason sufficiently detailed to explain withdrawal',
          },
        ],
      }),
    );
    expect(unauthorized.parseStatus).toBe('PARSE_FAILED');
    await process(
      fx,
      author,
      envelope({
        resolutions: [
          {
            objectionId: o.id,
            action: 'withdraw',
            reason: 'TEST original assumption was invalid because the evidence contradicts it',
          },
        ],
      }),
    );
    expect((await fx.db.objections.get(o.id))?.status).toBe('resolved');
  });
  it('T06 rejection keeps a dispute open; simple agreement cannot close a major dispute', async () => {
    const { fx, tasks } = await setup();
    const c = await addClaim(fx, tasks[0]!);
    await process(
      fx,
      tasks[1]!,
      envelope({
        objections: [
          {
            claimId: c.id,
            title: 'TEST',
            description: 'TEST DISPUTE',
            severity: 'critical',
            targetParticipantIds: [c.ownerId],
            evidence: [],
          },
        ],
      }),
    );
    const o = (await fx.db.objections.toArray())[0]!;
    await process(
      fx,
      tasks[0]!,
      envelope({
        resolutions: [
          {
            objectionId: o.id,
            action: 'reject',
            reason: 'TEST original evidence is still insufficient to resolve this issue',
          },
        ],
      }),
    );
    expect((await fx.db.objections.get(o.id))?.status).toBe('disputed');
    await process(
      fx,
      tasks[1]!,
      envelope({ resolutions: [{ objectionId: o.id, action: 'withdraw', reason: '我同意' }] }),
    );
    expect((await fx.db.objections.get(o.id))?.status).toBe('disputed');
  });
  it('requires all relevant members to accept the revised version before resolution', async () => {
    const { fx, tasks } = await setup();
    const a = tasks[0]!,
      b = tasks[1]!;
    const c = await addClaim(fx, a);
    await process(
      fx,
      b,
      envelope({
        objections: [
          {
            claimId: c.id,
            title: 'TEST',
            description: 'TEST DISPUTE',
            severity: 'major',
            targetParticipantIds: [c.ownerId],
            evidence: [],
          },
        ],
      }),
    );
    const o = (await fx.db.objections.toArray())[0]!;
    await process(
      fx,
      a,
      envelope({
        claims: [
          {
            key: 'proposal',
            description: 'TEST CORRECTED PROPOSAL',
            category: 'fact',
            critical: true,
          },
        ],
      }),
    );
    for (const task of [a, b])
      await process(
        fx,
        task,
        envelope({
          resolutions: [
            {
              objectionId: o.id,
              action: 'accept_revision',
              reason: 'TEST revised version directly addresses the missing evidence',
            },
          ],
        }),
      );
    expect((await fx.db.objections.get(o.id))?.status).toBe('resolved');
  });
  it('atomic parsing rolls back partial claims on an invalid reference and retains raw reply', async () => {
    const { fx, tasks } = await setup();
    const m = await process(
      fx,
      tasks[0]!,
      envelope({
        claims: [
          { key: 'a', description: 'TEST PROPOSAL', category: 'recommendation', critical: true },
        ],
        positions: [
          {
            claimId: 'missing',
            version: 1,
            position: 'AGREE',
            reason: 'TEST invalid reference has a reason',
            conditions: [],
            final: true,
          },
        ],
      }),
    );
    expect(m.parseStatus).toBe('PARSE_FAILED');
    expect(m.content).toContain('missing');
    expect(await fx.db.claims.count()).toBe(0);
  });
  it('facts record user provenance and local calculations check arithmetic only', async () => {
    const { fx, tasks, d } = await setup();
    const c = await addClaim(fx, tasks[0]!);
    const facts = new FactCheckManager(fx.db);
    const record = await facts.record({
      discussionId: d.id,
      claimId: c.id,
      evidenceSource: 'USER DOCUMENT',
      evidenceDescription: 'TEST DOCUMENT SPECIFIC EVIDENCE',
      verificationStatus: 'UNVERIFIED',
    });
    expect(record.provenance).toBe('user_document');
    const computed = await facts.calculate({
      discussionId: d.id,
      claimId: c.id,
      operation: 'product',
      operands: [2, 3, 4],
      expected: 24,
    });
    expect(computed.verificationStatus).toBe('VERIFIED');
    expect(computed.calculation?.result).toBe(24);
    expect(
      (
        await facts.calculate({
          discussionId: d.id,
          claimId: c.id,
          operation: 'sum',
          operands: [2, 3],
          expected: 6,
        })
      ).verificationStatus,
    ).toBe('CONTRADICTED');
  });
  it('facts reject cross-task sources, invalid applicability and arithmetic overflow', async () => {
    const { fx, tasks, d } = await setup();
    const c = await addClaim(fx, tasks[0]!);
    const other = await fx.create();
    const manager = new FactCheckManager(fx.db);
    await expect(
      manager.record({
        discussionId: other.id,
        claimId: c.id,
        evidenceSource: 'TEST',
        evidenceDescription: 'TEST',
        verificationStatus: 'VERIFIED',
      }),
    ).rejects.toThrow();
    await expect(
      manager.record({
        discussionId: d.id,
        claimId: c.id,
        evidenceSource: 'TEST',
        evidenceDescription: 'TEST',
        verificationStatus: 'NOT_APPLICABLE',
      }),
    ).rejects.toThrow();
    await expect(
      manager.calculate({
        discussionId: d.id,
        claimId: c.id,
        operation: 'product',
        operands: [1e300, 1e300],
        expected: 1,
      }),
    ).rejects.toThrow();
  });
});
