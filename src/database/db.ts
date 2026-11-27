import Dexie, { type Table } from 'dexie';
import type {
  Participant,
  Discussion,
  DiscussionMessage,
  Round,
  Claim,
  ClaimRevision,
  Position,
  Objection,
  ConsensusRecord,
  FactCheck,
  QueueTask,
  AuditLog,
  StoredReport,
  Lease,
  Snapshot,
  BrowserSession,
  BrowserDelivery,
  ChatNotice,
  BrainRequest,
  ActiveRequest,
  RecoveredDraft,
} from '../protocols/domain';

export class CouncilDB extends Dexie {
  participants!: Table<Participant, string>;
  discussions!: Table<Discussion, string>;
  messages!: Table<DiscussionMessage, string>;
  rounds!: Table<Round, string>;
  claims!: Table<Claim, string>;
  claim_revisions!: Table<ClaimRevision, string>;
  positions!: Table<Position, string>;
  objections!: Table<Objection, string>;
  consensus_records!: Table<ConsensusRecord, string>;
  fact_checks!: Table<FactCheck, string>;
  task_queue!: Table<QueueTask, string>;
  logs!: Table<AuditLog, string>;
  reports!: Table<StoredReport, string>;
  leases!: Table<Lease, string>;
  browser_sessions!: Table<BrowserSession, string>;
  browser_deliveries!: Table<BrowserDelivery, string>;
  chat_notices!: Table<ChatNotice, string>;
  brain_requests!: Table<BrainRequest, string>;
  runtime_state!: Table<ActiveRequest, string>;
  recovered_drafts!: Table<RecoveredDraft, string>;
  constructor(name = 'ai-council') {
    super(name);
    this.version(1).stores({
      participants: 'id,platform,updatedAt',
      discussions: 'id,status,updatedAt',
      messages: 'id,&dedupeKey,discussionId,[discussionId+participantId],roundId,replyTo',
      rounds: 'id,discussionId,&[discussionId+roundNumber]',
      claims: 'id,discussionId,[discussionId+ownerId]',
      objections: 'id,discussionId,relatedClaimId',
      consensus_records: 'id,discussionId,&[discussionId+roundNumber]',
      fact_checks: 'id,discussionId,claimId',
      task_queue: 'id,&dedupeKey,discussionId,status,[status+nextRetryAt]',
      logs: 'id,discussionId,createdAt',
      reports: 'id,&discussionId',
      leases: 'id',
    });
    this.version(2)
      .stores({
        claim_revisions: 'id,discussionId,claimId,&[claimId+version]',
        positions: 'id,discussionId,claimId,&[discussionId+participantId+claimId]',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Discussion, string>('discussions')
          .toCollection()
          .modify((d) => {
            d.noProgressRounds ??= 0;
            d.lastProgressFingerprint ??= '';
          });
      });
    this.version(3).stores({
      browser_sessions: 'id,discussionId,participantId,&[discussionId+participantId]',
      browser_deliveries: 'id,discussionId,participantId,tabId',
    });
    this.version(4)
      .stores({
        chat_notices: 'id,createdAt,discussionId',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Participant, string>('participants')
          .toCollection()
          .modify((p) => {
            p.role ??= 'council';
          });
      });
    this.version(5)
      .stores({ brain_requests: 'id,participantId,phase,createdAt,discussionId' })
      .upgrade(async (tx) => {
        await tx
          .table<Discussion, string>('discussions')
          .toCollection()
          .modify((discussion) => {
            discussion.mode ??= 'free';
            discussion.verificationPolicy ??= 'independent_evidence';
          });
      });
    this.version(6)
      .stores({ runtime_state: 'id,discussionId' })
      .upgrade(async (tx) => {
        await tx
          .table<Discussion, string>('discussions')
          .toCollection()
          .modify((discussion) => {
            if (
              ['CREATED', 'PAUSED', 'COMPLETED', 'UNRESOLVED', 'FAILED'].includes(discussion.status)
            )
              return;
            discussion.resumeStatus = discussion.status;
            discussion.status = 'PAUSED';
            discussion.reason = 'UPGRADE_REVIEW_REQUIRED';
            discussion.reasonDetail =
              '升级已暂停旧题队列。只有明确恢复这道题才会继续发送；新提问不会恢复旧题。';
            discussion.updatedAt = Date.now();
          });
        await tx
          .table<BrainRequest, string>('brain_requests')
          .toCollection()
          .modify((request) => {
            if (
              request.phase === 'done' ||
              request.phase === 'paused' ||
              request.phase === 'cancelled'
            )
              return;
            request.resumePhase = request.phase;
            request.phase = 'paused';
            request.error = {
              code: 'UPGRADE_REVIEW_REQUIRED',
              detail: '升级已暂停旧路由，请确认原问题后再恢复。',
            };
            request.updatedAt = Date.now();
          });
      });
    this.version(7).stores({ recovered_drafts: 'id,discussionId,participantId,createdAt' });
  }
  private async brainSnapshot(): Promise<BrainRequest[]> {
    const recent = await this.brain_requests.orderBy('createdAt').reverse().limit(100).toArray();
    const unfinished = await this.brain_requests
      .where('phase')
      .anyOf('pending', 'sending', 'waiting', 'routing', 'paused')
      .toArray();
    return [
      ...new Map([...recent, ...unfinished].map((request) => [request.id, request])).values(),
    ].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  async snapshot(): Promise<Snapshot> {
    return this.transaction('r', this.tables, async () => ({
      recoveredDrafts: await this.recovered_drafts.toArray(),
      activeRequest: await this.runtime_state.get('foreground'),
      participants: await this.participants.toArray(),
      discussions: await this.discussions.toArray(),
      messages: await this.messages.toArray(),
      rounds: await this.rounds.toArray(),
      claims: await this.claims.toArray(),
      claimRevisions: await this.claim_revisions.toArray(),
      positions: await this.positions.toArray(),
      objections: await this.objections.toArray(),
      consensusRecords: await this.consensus_records.toArray(),
      factChecks: await this.fact_checks.toArray(),
      queue: await this.task_queue.toArray(),
      logs: await this.logs.orderBy('createdAt').reverse().limit(200).toArray(),
      reports: await this.reports.toArray(),
      browserSessions: await this.browser_sessions.toArray(),
      browserDeliveries: await this.browser_deliveries.toArray(),
      chatNotices: await this.chat_notices.orderBy('createdAt').reverse().limit(100).toArray(),
      brainRequests: await this.brainSnapshot(),
    }));
  }
  async clearLocalData(): Promise<void> {
    // Keep participant/model configuration; wipe discussion runtime data only.
    await this.transaction('rw', this.tables, async () => {
      for (const table of this.tables) {
        if (table.name === 'participants') continue;
        await table.clear();
      }
    });
  }
}
