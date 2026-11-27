import type { DomStructureDiagnostic } from '../../protocols/domain';
export interface PageProfile {
  id: string;
  origins: string[];
  newConversationUrl: string;
  newConversationButtons?: string[];
  editors: string[];
  assistants: string[];
  users: string[];
  sendButtons: string[];
  stopButtons: string[];
  completionButtons: string[];
  loginButtons: string[];
}
export interface PageRequest {
  captureDraft?: boolean;
  expectedUrl?: string;
  /** Only task preparation may foreground an inspection; optional diagnostics remain passive. */
  activate?: boolean;
  operation:
    | 'inspect'
    | 'submit'
    | 'observe'
    | 'new_conversation'
    | 'clear_draft'
    | 'restore_draft';
  profile: PageProfile;
  marker?: string;
  prompt?: string;
}
export interface PageObservation {
  draftText?: string;
  draftState?: 'cleared' | 'changed' | 'restored' | 'blocked';
  draftMatchesRequest?: boolean;
  newConversationState?: 'empty' | 'requested' | 'not_found';
  emptyConversation?: boolean;
  structure?: DomStructureDiagnostic;
  selectors?: {
    editor: string | null;
    assistant: string | null;
    completion: string | null;
    send: string | null;
  };
  url: string;
  editorFound: boolean;
  editorEmpty: boolean;
  outputCount: number;
  userCount: number;
  submitControlFound: boolean;
  completionControlFound: boolean;
  busy: boolean;
  login: 'logged_in' | 'logged_out' | 'unknown';
  blocked: boolean;
  reason: string;
  markerFound: boolean;
  raw: string;
  outputId: string;
  dispatched: boolean;
}
