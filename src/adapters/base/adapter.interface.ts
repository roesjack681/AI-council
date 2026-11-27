import type { CapabilityCheck, Participant, QueueTask } from '../../protocols/domain';
import type { PageRequest, PageObservation } from '../dom/page-protocol';

export interface BrowserTab {
  id: number;
  url: string;
  status: 'loading' | 'complete' | 'unloaded' | undefined;
}
export interface BrowserPort {
  tabs(): Promise<BrowserTab[]>;
  open(url: string): Promise<void>;
  create?(url: string): Promise<BrowserTab>;
  page?(tabId: number, request: PageRequest): Promise<PageObservation>;
}
export interface Receipt {
  id: string;
  submittedAt: number;
}
export type PollResult =
  | { state: 'pending' }
  | { state: 'complete'; externalMessageId: string; raw: string }
  | { state: 'logged_out' | 'restricted' | 'unavailable'; reason: string };
export type Reconciliation =
  | { state: 'not_sent' }
  | { state: 'unknown' }
  | { state: 'submitted'; receipt: Receipt };
export type CompletedResponse = Extract<PollResult, { state: 'complete' }>;
/** Transport checks and policy information are separate. Browser DOM mode is user directed.
 * No private-network fallback. Reconciliation must never infer success from a click.
 */
export interface PlatformAdapter {
  readonly id: string;
  readonly version: string;
  readonly origins: readonly string[];
  inspect(participant: Participant, browser: BrowserPort): Promise<CapabilityCheck>;
  /** Prepare only this task's dedicated tab; no previous model answer is required. */
  prepareInitial?(participant: Participant, discussionId: string): Promise<CapabilityCheck>;
  submit(task: QueueTask, prompt: string, idempotencyKey: string): Promise<Receipt>;
  reconcile(task: QueueTask, idempotencyKey: string): Promise<Reconciliation>;
  poll(task: QueueTask, receipt: Receipt): Promise<PollResult>;
  /** Local, previously completed response only. Must not operate a webpage. */
  cachedResponse?(task: QueueTask, receipt: Receipt): Promise<CompletedResponse | undefined>;
}
