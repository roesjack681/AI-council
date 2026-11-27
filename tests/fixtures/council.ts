// Test-only transport. It is never a real model response, never exported from src,
// and never included in an extension build. Callers supply every test response.
import { CouncilDB } from '../../src/database/db';
import { AdapterRegistry } from '../../src/adapters/registry';
import type {
  PlatformAdapter,
  BrowserPort,
  Receipt,
  PollResult,
  Reconciliation,
} from '../../src/adapters/base/adapter.interface';
import type {
  CapabilityCheck,
  ModelResponse,
  QueueTask,
  Discussion,
} from '../../src/protocols/domain';
import { CouncilService } from '../../src/services/council-service';
import { ParticipantService } from '../../src/services/participant-service';
import { TaskManager } from '../../src/core/task-manager';
import { CouncilError } from '../../src/utils/errors';
export const browser: BrowserPort = {
  async tabs() {
    return [{ id: 1, url: 'https://council.test', status: 'complete' }];
  },
  async open() {},
};
export const envelope = (partial: Partial<ModelResponse> = {}): ModelResponse => ({
  type: 'REVIEW',
  brief: 'TEST FIXTURE: agree with the current proposal for transport testing.',
  content: 'TEST FIXTURE ONLY: test statement with explicit rationale.',
  claims: [],
  positions: [],
  objections: [],
  resolutions: [],
  ...partial,
});
export class TestAdapter implements PlatformAdapter {
  readonly id = 'custom';
  readonly version = 'test-only';
  readonly origins = ['https://council.test'];
  readonly submissions = new Map<string, Receipt>();
  submitCalls = 0;
  pollCalls = 0;
  safeFailures = 0;
  loseAck = false;
  unknown = false;
  pending = false;
  login: 'logged_in' | 'logged_out' = 'logged_in';
  allowed = true;
  answer: (task: QueueTask) => Promise<string> = async () => {
    throw new Error('No test response configured');
  };
  async inspect(): Promise<CapabilityCheck> {
    return {
      checkedAt: Date.now(),
      adapterVersion: this.version,
      tabIds: [1],
      pageOpen: true,
      pageReachable: 'yes',
      login: this.login,
      policy: this.allowed ? 'allowed' : 'restricted',
      technicalVerified: true,
      capabilities: {
        canReadOutput: true,
        canSubmitMessage: true,
        canDetectCompletion: true,
        canDetectLogin: true,
        canCaptureUserQuestion: false,
        unattendedAllowed: true,
      },
      reasons: ['TEST TRANSPORT; NO REAL MODEL'],
      sources: [],
    };
  }
  async submit(task: QueueTask, _prompt: string, key: string): Promise<Receipt> {
    this.submitCalls++;
    if (this.safeFailures-- > 0)
      throw new CouncilError('TEST_NOT_SENT', 'Test explicitly not sent', true, true);
    const prior = this.submissions.get(key);
    if (prior) return prior;
    const receipt = { id: `receipt:${task.id}`, submittedAt: Date.now() };
    this.submissions.set(key, receipt);
    if (this.loseAck) throw new CouncilError('TEST_ACK_LOST', 'Test acknowledgment lost');
    return receipt;
  }
  async reconcile(_task: QueueTask, key: string): Promise<Reconciliation> {
    if (this.unknown) return { state: 'unknown' };
    const receipt = this.submissions.get(key);
    return receipt ? { state: 'submitted', receipt } : { state: 'not_sent' };
  }
  async poll(task: QueueTask): Promise<PollResult> {
    this.pollCalls++;
    if (this.pending) return { state: 'pending' };
    return {
      state: 'complete',
      externalMessageId: `external:${task.id}`,
      raw: await this.answer(task),
    };
  }
}
export async function fixture(participantCount = 2) {
  const db = new CouncilDB(`test-${crypto.randomUUID()}`);
  await db.open();
  const adapter = new TestAdapter();
  const registry = new AdapterRegistry([adapter]);
  const service = new CouncilService(db, browser, registry);
  const participants = new ParticipantService(db, registry, browser);
  const ids: string[] = [];
  for (let i = 0; i < participantCount; i++)
    ids.push(
      (
        await participants.add({
          name: `TEST MEMBER ${i}`,
          platform: 'custom',
          websiteUrl: 'https://council.test',
          enabled: true,
        })
      ).id,
    );
  const create = async (overrides: Partial<Discussion> = {}) =>
    new TaskManager(db).create({
      title: 'TEST DISCUSSION',
      originalQuestion: 'TEST ORIGINAL QUESTION',
      context: '',
      constraints: [],
      expectedOutput: '',
      participantIds: ids,
      maxRounds: 10,
      stableRoundsRequired: 2,
      timeoutMs: 1000,
      maxRetries: 2,
      privacyAcknowledged: true,
      ...overrides,
    });
  return {
    db,
    adapter,
    registry,
    service,
    participants,
    ids,
    create,
    async cleanup() {
      db.close();
      await db.delete();
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function tick(f: Fixture, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await f.db.task_queue.toCollection().modify({ nextRetryAt: 0, leaseUntil: 0 });
    await f.service.scheduler.tick();
  }
}
export async function agreeingResponse(f: Fixture, task: QueueTask): Promise<string> {
  if (task.taskType === 'initial')
    return JSON.stringify(
      envelope({
        type: 'INITIAL_ANSWER',
        claims: [
          {
            key: 'proposal',
            description: `TEST PROPOSAL ${task.participantId}`,
            category: 'recommendation',
            critical: true,
          },
        ],
      }),
    );
  const claims = await f.db.claims.where('discussionId').equals(task.discussionId).toArray();
  return JSON.stringify(
    envelope({
      type: 'FINAL_POSITION',
      positions: claims.map((c) => ({
        claimId: c.id,
        version: c.version,
        position: 'AGREE',
        reason: 'TEST rationale explicitly supports the current version',
        final: true,
        conditions: [],
      })),
    }),
  );
}
