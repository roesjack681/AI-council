import { z } from 'zod';

export const idSchema = z.string().min(1).max(300);
export const textSchema = z.string().trim().min(1).max(200_000);
export const platformSchema = z.enum([
  'deepseek',
  'doubao',
  'chatgpt',
  'gemini',
  'claude',
  'custom',
]);
export type Platform = z.infer<typeof platformSchema>;
export const capabilitiesSchema = z
  .object({
    canReadOutput: z.boolean(),
    canSubmitMessage: z.boolean(),
    canDetectCompletion: z.boolean(),
    canDetectLogin: z.boolean(),
    canCaptureUserQuestion: z.boolean(),
    unattendedAllowed: z.boolean(),
  })
  .strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const participantRoleSchema = z.enum(['council', 'brain']);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;
export const participantInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Emoji or local data:image URL shown in the chat room. */
    avatar: z.string().trim().max(200_000).default(''),
    platform: platformSchema,
    websiteUrl: z.url().max(2000),
    enabled: z.boolean(),
    role: participantRoleSchema.default('council'),
  })
  .strict();
export type ParticipantInput = z.input<typeof participantInputSchema>;
export const participantProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    avatar: z.string().trim().max(200_000).optional(),
    role: participantRoleSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.avatar !== undefined || v.role !== undefined,
    '至少更新名称、头像或角色',
  );
export type ParticipantProfileUpdate = z.infer<typeof participantProfileSchema>;
export const brainRouteSchema = z
  .object({
    intent: z.enum(['check_ready', 'direct_ask', 'council_discuss']),
    targets: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    task: z.string().trim().max(10_000).default(''),
    brief: z.string().trim().min(8).max(120),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type BrainRoute = z.infer<typeof brainRouteSchema>;
/** Dedicated discussion id for the brain router tab; never a real council task. */
export const BRAIN_DISCUSSION_ID = '__brain__';
export const isBrainDiscussion = (id: string): boolean =>
  id === BRAIN_DISCUSSION_ID || id.startsWith(`${BRAIN_DISCUSSION_ID}:`);
/** Counts and tag names only: never includes conversation text or account attributes. */
export interface DomStructureDiagnostic {
  readerVersion: string;
  headingCount: number;
  assistantHeadingCount: number;
  userHeadingCount: number;
  hiddenTextHeadingCount: number;
  openShadowRootCount: number;
  iframeCount: number;
  headings: Array<{
    tag: string;
    role: string | null;
    visibleTextLength: number;
    rawTextLength: number;
    speaker: 'assistant' | 'user' | 'unrecognized';
    display: string;
    hasRect: boolean;
    parentTag: string | null;
  }>;
}
export interface CapabilityCheck {
  /** A matched editor can bootstrap an isolated session; this is not verified output reading. */
  sessionPreparationAllowed?: boolean;
  /** A bounded first-message attempt on a positively identified empty page; never verified reading. */
  firstMessageAllowed?: boolean;
  failureCode?: string;
  diagnostics?: {
    tabId: number;
    origin: string;
    editorFound?: boolean;
    emptyConversation?: boolean;
    outputCount?: number;
    completionControlFound?: boolean;
    busy?: boolean;
    login?: 'unknown' | 'logged_in' | 'logged_out';
    errorCode?: string;
    structure?: DomStructureDiagnostic;
    selectors?: {
      editor: string | null;
      assistant: string | null;
      completion: string | null;
      send: string | null;
    };
  }[];
  interactionMode?: 'metadata_only' | 'browser_dom';
  checkedAt: number;
  adapterVersion: string;
  tabIds: number[];
  pageOpen: boolean;
  pageReachable: 'unknown' | 'yes' | 'no';
  login: 'unknown' | 'logged_in' | 'logged_out';
  policy: 'restricted' | 'unverified' | 'allowed';
  technicalVerified: boolean;
  capabilities: Capabilities;
  reasons: string[];
  sources: string[];
}
export interface Participant extends ParticipantInput {
  id: string;
  adapterId: string;
  adapterVersion: string;
  capabilities: Capabilities;
  /** Defaults to council for records created before role existed. */
  role: ParticipantRole;
  status:
    | 'available'
    | 'first_message_ready'
    | 'logged_out'
    | 'unsupported'
    | 'restricted'
    | 'error';
  reason: string;
  check?: CapabilityCheck;
  createdAt: number;
  updatedAt: number;
}
export const statuses = [
  'CREATED',
  'INITIALIZING',
  'INITIAL_ANSWERS',
  'FREE_DISCUSSION',
  'OBJECTION_REVIEW',
  'CONSENSUS_CHECK',
  'FINALIZING',
  'COMPLETED',
  'UNRESOLVED',
  'PAUSED',
  'FAILED',
] as const;
export type DiscussionStatus = (typeof statuses)[number];
export const discussionModeSchema = z.enum(['free', 'direct']);
export const verificationPolicySchema = z.enum(['discussion_only', 'independent_evidence']);
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;
export type DiscussionMode = z.infer<typeof discussionModeSchema>;
export const discussionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    originalQuestion: textSchema,
    context: z.string().max(100_000),
    constraints: z.array(z.string().trim().min(1).max(2000)).max(100),
    expectedOutput: z.string().max(10_000),
    mode: discussionModeSchema.default('free'),
    verificationPolicy: verificationPolicySchema.optional(),
    participantIds: z
      .array(idSchema)
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, '参与者不可重复'),
    maxRounds: z.number().int().min(1).max(100),
    stableRoundsRequired: z.number().int().min(1).max(10),
    timeoutMs: z.number().int().min(1000).max(3_600_000),
    maxRetries: z.number().int().min(0).max(5),
    privacyAcknowledged: z.literal(true),
    brainBrief: z.string().trim().max(500).optional(),
    brainIntent: z.enum(['check_ready', 'direct_ask', 'council_discuss']).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.mode === 'free' && data.participantIds.length < 2) {
      ctx.addIssue({
        code: 'custom',
        message: '共识讨论至少需要两名参与者',
        path: ['participantIds'],
      });
    }
    if (data.mode === 'free' && data.maxRounds < 2) {
      ctx.addIssue({ code: 'custom', message: '共识讨论轮数至少为 2', path: ['maxRounds'] });
    }
  });
export type DiscussionInput = z.input<typeof discussionInputSchema>;
export interface Discussion extends Omit<DiscussionInput, 'mode'> {
  startup?: {
    startedAt: number;
    deadline: number;
    nextCheckAt: number;
    attempts: number;
    lastCode?: string;
  };
  userRequestId?: string;
  participantSnapshots?: {
    id: string;
    name: string;
    platform: Platform;
    adapterId: string;
    adapterVersion: string;
  }[];
  id: string;
  mode: DiscussionMode;
  status: DiscussionStatus;
  resumeStatus?: DiscussionStatus;
  currentRound: number;
  noProgressRounds: number;
  lastProgressFingerprint: string;
  reason?: string;
  reasonDetail?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}
export interface ChatNotice {
  id: string;
  type: 'brain' | 'readiness';
  title: string;
  body: string;
  discussionId?: string;
  createdAt: number;
}
export interface BrainRequest {
  userRequestId?: string;
  verificationPolicy: VerificationPolicy;
  id: string;
  participantId: string;
  question: string;
  prompt: string;
  task: QueueTask;
  phase: 'pending' | 'sending' | 'waiting' | 'routing' | 'done' | 'paused' | 'cancelled';
  resumePhase?: 'pending' | 'sending' | 'waiting' | 'routing';
  receipt?: { id: string; submittedAt: number };
  deadline?: number;
  raw?: string;
  route?: BrainRoute;
  discussionId?: string;
  noticeIds: string[];
  repairCount: number;
  retryCount: number;
  confirmationAttempts: number;
  nextRetryAt: number;
  error?: { code: string; detail: string };
  createdAt: number;
  updatedAt: number;
}
export const messageTypeSchema = z.enum([
  'INITIAL_ANSWER',
  'REVIEW',
  'OBJECTION',
  'RESPONSE',
  'REVISION',
  'AGREEMENT',
  'DISAGREEMENT',
  'FACT_CHECK',
  'FINAL_POSITION',
]);
export type MessageType = z.infer<typeof messageTypeSchema>;
export const categorySchema = z.enum([
  'fact',
  'assumption',
  'inference',
  'calculation',
  'recommendation',
  'unverified',
]);
export type ClaimCategory = z.infer<typeof categorySchema>;
export const positionSchema = z.enum(['AGREE', 'CONDITIONAL', 'DISAGREE', 'UNCERTAIN', 'ABSTAIN']);
export type ConsensusPosition = z.infer<typeof positionSchema>;
export const responseSchema = z
  .object({
    type: messageTypeSchema,
    brief: z.string().trim().min(1).max(280).optional(),
    content: textSchema,
    claims: z
      .array(
        z
          .object({
            key: z.string().min(1).max(80),
            description: textSchema,
            category: categorySchema,
            critical: z.boolean(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    positions: z
      .array(
        z
          .object({
            claimId: idSchema,
            version: z.number().int().positive(),
            position: positionSchema,
            reason: z.string().trim().min(8).max(10_000),
            final: z.boolean(),
            conditions: z
              .array(z.object({ description: textSchema, evidenceIds: z.array(idSchema) }).strict())
              .max(30),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    objections: z
      .array(
        z
          .object({
            claimId: idSchema,
            title: z.string().trim().min(1).max(300),
            description: textSchema,
            severity: z.enum(['minor', 'major', 'critical']),
            targetParticipantIds: z.array(idSchema).min(1),
            evidence: z.array(z.string().max(4000)),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    resolutions: z
      .array(
        z
          .object({
            objectionId: idSchema,
            action: z.enum(['withdraw', 'accept_revision', 'reject']),
            reason: z.string().trim().min(3).max(10_000),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type ModelResponse = z.infer<typeof responseSchema>;
export interface DiscussionMessage {
  id: string;
  dedupeKey: string;
  discussionId: string;
  roundId: string;
  participantId: string;
  direction: 'outbound' | 'inbound';
  type: MessageType;
  content: string;
  structuredData?: ModelResponse;
  parseStatus: 'not_applicable' | 'valid' | 'PARSE_FAILED';
  parseError?: { code: string; detail: string };
  replyTo?: string;
  relatedClaimIds: string[];
  relatedObjectionIds: string[];
  status: 'pending' | 'delivered' | 'received' | 'failed';
  createdAt: number;
}
export interface Round {
  id: string;
  discussionId: string;
  roundNumber: number;
  kind: 'initial' | 'review' | 'event' | 'confirmation';
  status: 'active' | 'completed';
  summary: string;
  startedAt: number;
  completedAt?: number;
}
export interface Claim {
  id: string;
  discussionId: string;
  ownerId: string;
  key: string;
  description: string;
  category: ClaimCategory;
  critical: boolean;
  version: number;
  status: 'active' | 'superseded';
  sourceMessageId: string;
  createdAt: number;
  updatedAt: number;
}
export interface ClaimRevision {
  id: string;
  claimId: string;
  discussionId: string;
  version: number;
  description: string;
  sourceMessageId: string;
  createdAt: number;
}
export interface Position {
  id: string;
  discussionId: string;
  participantId: string;
  claimId: string;
  claimVersion: number;
  position: ConsensusPosition;
  reason: string;
  final: boolean;
  conditions: { description: string; evidenceIds: string[] }[];
  sourceMessageId: string;
  roundNumber: number;
  createdAt: number;
}
export interface Objection {
  id: string;
  discussionId: string;
  title: string;
  description: string;
  sourceParticipantId: string;
  targetParticipantIds: string[];
  relatedClaimId: string;
  claimVersion: number;
  severity: 'minor' | 'major' | 'critical';
  status: 'open' | 'responding' | 'resolved' | 'unresolved' | 'disputed';
  evidence: string[];
  reviews: {
    participantId: string;
    action: 'withdraw' | 'accept_revision' | 'reject';
    reason: string;
    messageId: string;
    claimVersion: number;
  }[];
  resolution?: string;
  sourceMessageId: string;
  createdAt: number;
  resolvedAt?: number;
}
export const factInputSchema = z
  .object({
    discussionId: idSchema,
    claimId: idSchema,
    evidenceSource: z.string().trim().min(1).max(4000),
    evidenceDescription: z.string().trim().min(3).max(50_000),
    verificationStatus: z.enum([
      'VERIFIED',
      'CONTRADICTED',
      'UNVERIFIED',
      'INSUFFICIENT',
      'NOT_APPLICABLE',
    ]),
  })
  .strict();
export type FactInput = z.infer<typeof factInputSchema>;
export interface FactCheck extends FactInput {
  id: string;
  claimVersion: number;
  provenance: 'user_document' | 'local_calculation';
  verifiedAt: number;
  calculation?: { operands: number[]; operation: 'sum' | 'product'; result: number };
}
export interface ConsensusRecord {
  verificationPolicy?: VerificationPolicy;
  warnings?: string[];
  id: string;
  discussionId: string;
  roundNumber: number;
  reached: boolean;
  participantCompletion: boolean;
  coreClaimsAccepted: boolean;
  unresolvedMajorObjections: number;
  unresolvedCriticalObjections: number;
  unresolvedConditions: number;
  unverifiedCriticalFacts: number;
  stableRounds: number;
  reasons: string[];
  fingerprint: string;
  participantPositions: Position[];
  unresolvedObjections: string[];
  unverifiedFacts: string[];
  checkedAt: number;
}
export interface QueueTask {
  preflightDeadline?: number;
  id: string;
  dedupeKey: string;
  discussionId: string;
  participantId: string;
  messageId: string;
  roundId: string;
  taskType: 'initial' | 'review' | 'event' | 'confirmation' | 'repair';
  status: 'pending' | 'sending' | 'waiting' | 'done' | 'failed';
  retryCount: number;
  nextRetryAt: number;
  leaseUntil: number;
  receiptId?: string;
  startedAt?: number;
  lastError?: string;
  confirmationAttempts?: number;
  createdAt: number;
  updatedAt: number;
}
export interface AuditLog {
  id: string;
  discussionId?: string;
  level: 'info' | 'warn' | 'error';
  code: string;
  detail: string;
  createdAt: number;
}
export interface StoredReport {
  id: string;
  discussionId: string;
  status: DiscussionStatus;
  markdown: string;
  html: string;
  json: string;
  createdAt: number;
}
export interface Lease {
  id: string;
  owner: string;
  until: number;
}
export interface Snapshot {
  recoveredDrafts?: RecoveredDraft[];
  activeRequest?: ActiveRequest;
  browserSessions: BrowserSession[];
  browserDeliveries: BrowserDelivery[];
  participants: Participant[];
  discussions: Discussion[];
  messages: DiscussionMessage[];
  rounds: Round[];
  claims: Claim[];
  claimRevisions: ClaimRevision[];
  positions: Position[];
  objections: Objection[];
  consensusRecords: ConsensusRecord[];
  factChecks: FactCheck[];
  queue: QueueTask[];
  logs: AuditLog[];
  reports: StoredReport[];
  chatNotices: ChatNotice[];
  brainRequests: BrainRequest[];
}
export interface RecoveredDraft {
  id: string;
  discussionId: string;
  participantId: string;
  tabId: number;
  origin: string;
  url: string;
  marker: string;
  content: string;
  digest: string;
  reason: 'saved_request' | 'legacy_envelope';
  phase: 'saved' | 'cleared' | 'changed' | 'restored';
  attempts: number;
  createdAt: number;
  updatedAt: number;
}
export interface ActiveRequest {
  id: 'foreground';
  requestId: string;
  discussionId?: string;
  brainRequestId?: string;
  updatedAt: number;
}
export interface BrowserSession {
  id: string;
  discussionId: string;
  participantId: string;
  tabId: number;
  origin: string;
  createdAt: number;
  preparation?: {
    resetHadTranscript?: boolean;
    preparedUrl?: string;
    readProof?: { adapterVersion: string; checkedAt: number };
    phase: 'reset_requested' | 'ready' | 'blocked';
    requestedAt?: number;
    checkedAt: number;
    editorFound: boolean;
    editorEmpty: boolean;
    userCount: number;
    outputCount: number;
    reason: string;
  };
}
export interface BrowserDelivery {
  id: string;
  discussionId: string;
  participantId: string;
  tabId: number;
  marker: string;
  phase: 'prepared' | 'submitted' | 'complete';
  submittedAt: number;
  lastText: string;
  lastChangedAt: number;
  observations: number;
  generationSeen: boolean;
  raw?: string;
}
