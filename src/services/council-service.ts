import { CouncilDB } from '../database/db';
import { AdapterRegistry } from '../adapters/registry';
import { ComplianceGate } from '../adapters/base/compliance-gate';
import type { BrowserPort } from '../adapters/base/adapter.interface';
import { TaskManager } from '../core/task-manager';
import { ParticipantService } from './participant-service';
import { DiscussionEngine } from '../core/discussion-engine';
import { Scheduler } from '../background/scheduler';
import { ReportGenerator } from '../reports/report-generator';
import { FactCheckManager } from '../core/fact-check-manager';
import { ChatAskService } from './chat-ask-service';
import { commandSchema, type CommandResult } from '../protocols/commands';
import { errorText, CouncilError } from '../utils/errors';
import { log } from '../utils/logger';
import { recover } from '../background/recovery';
import { RequestCoordinator } from '../core/request-coordinator';
import { DraftRecovery } from '../adapters/dom/draft-recovery';
import { domProfiles } from '../adapters/dom/profiles';
import { requireValue } from '../utils/errors';
export class CouncilService {
  readonly gate: ComplianceGate;
  readonly engine: DiscussionEngine;
  readonly scheduler: Scheduler;
  private readonly participants: ParticipantService;
  private readonly chat: ChatAskService;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly db: CouncilDB,
    private readonly browser: BrowserPort,
    registry = new AdapterRegistry(undefined, { db, browser }),
  ) {
    this.gate = new ComplianceGate(db, registry, browser);
    this.engine = new DiscussionEngine(db, this.gate);
    this.scheduler = new Scheduler(db, this.gate, this.engine);
    this.participants = new ParticipantService(db, registry, browser);
    this.chat = new ChatAskService(db, this.gate, registry, this.engine, this.scheduler);
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.catch(() => undefined);
    return result;
  }
  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      await this.db.open();
      await recover(this.db, this.gate);
    });
  }
  async execute(raw: unknown): Promise<CommandResult> {
    return this.exclusive(async () => {
      try {
        const c = commandSchema.parse(raw);
        const tasks = new TaskManager(this.db);
        let data: unknown = null;
        switch (c.type) {
          case 'snapshot':
            data = await this.db.snapshot();
            break;
          case 'participant.add':
            data = await this.participants.add(c.input);
            break;
          case 'participant.enable':
            await this.participants.setEnabled(c.id, c.enabled);
            break;
          case 'participant.update':
            data = await this.participants.updateProfile(c.id, c.input);
            break;
          case 'participant.remove':
            await this.participants.remove(c.id);
            break;
          case 'participant.check':
            data = await this.gate.inspect(c.id);
            break;
          case 'participant.open':
            await this.participants.open(c.id);
            break;
          case 'discussion.create':
            data = await tasks.create(c.input);
            break;
          case 'discussion.start':
            await new RequestCoordinator(this.db).activateDiscussion(c.id);
            await this.engine.start(c.id);
            await this.scheduler.tick();
            break;
          case 'discussion.pause':
            await tasks.pause(c.id);
            break;
          case 'discussion.stop':
            await tasks.stop(c.id);
            await new ReportGenerator(this.db).generate(c.id);
            break;
          case 'discussion.delete':
            await tasks.delete(c.id);
            break;
          case 'draft.restore': {
            const draft = requireValue(
              await this.db.recovered_drafts.get(c.id),
              '保留的草稿不存在',
            );
            const participant = requireValue(
              await this.db.participants.get(draft.participantId),
              '参与者不存在',
            );
            const profile = requireValue(
              domProfiles.find((p) => p.id === participant.adapterId),
              '平台不支持草稿恢复',
            );
            await new DraftRecovery(this.db, this.browser, profile).restore(draft);
            break;
          }
          case 'report.generate':
            data = await new ReportGenerator(this.db).generate(c.id);
            break;
          case 'fact.record':
            data = await new FactCheckManager(this.db).record(c.input);
            break;
          case 'fact.calculate':
            data = await new FactCheckManager(this.db).calculate(c.input);
            break;
          case 'data.clear':
            await this.db.clearLocalData();
            break;
          case 'chat.ask':
            data = await this.chat.ask(c.question, c.verificationPolicy);
            break;
          case 'brain.resume':
            await this.chat.resume(c.id);
            break;
          case 'brain.cancel':
            await this.chat.cancel(c.id);
            break;
          case 'tick':
            {
              const active = await this.db.runtime_state.get('foreground');
              const task = active?.discussionId
                ? await this.db.discussions.get(active.discussionId)
                : undefined;
              if (task?.status === 'PAUSED' && task.reason === 'DRAFT_PRESENT')
                await recover(this.db, this.gate);
            }
            await this.chat.advance();
            await this.scheduler.tick();
            break;
        }
        return { ok: true, data };
      } catch (error) {
        await log(
          this.db,
          'error',
          'COMMAND_FAILED',
          error instanceof CouncilError ? error.code : 'VALIDATION_OR_STORAGE_ERROR',
        );
        return { ok: false, error: errorText(error) };
      }
    });
  }
}
