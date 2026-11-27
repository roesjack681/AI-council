export const PAGE_STARTUP_TIMEOUT_MS = 60_000;
export function isPagePreparationPending(code: string): boolean {
  return [
    'PAGE_LOADING',
    'PAGE_PROBE_FAILED',
    'PAGE_CHECK_FAILED',
    'EDITOR_NOT_FOUND',
    'SESSION_INITIALIZING',
    'PAGE_BUSY',
    'CAPABILITY_CHECK_FAILED',
  ].includes(code);
}
