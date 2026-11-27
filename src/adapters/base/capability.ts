import type { Capabilities, CapabilityCheck } from '../../protocols/domain';
export const noCapabilities = (): Capabilities => ({
  canReadOutput: false,
  canSubmitMessage: false,
  canDetectCompletion: false,
  canDetectLogin: false,
  canCaptureUserQuestion: false,
  unattendedAllowed: false,
});
export function isReady(check: CapabilityCheck, version: string, now = Date.now()): boolean {
  const c = check.capabilities;
  return (
    (check.interactionMode === 'browser_dom' || check.policy === 'allowed') &&
    check.technicalVerified &&
    check.adapterVersion === version &&
    check.checkedAt <= now &&
    now - check.checkedAt < 120_000 &&
    check.pageOpen &&
    check.pageReachable === 'yes' &&
    check.login === 'logged_in' &&
    c.canReadOutput &&
    c.canSubmitMessage &&
    c.canDetectCompletion &&
    c.canDetectLogin &&
    c.unattendedAllowed
  );
}

/** Permission to try the initial question; deliberately separate from isReady and all capability flags. */
export function canBeginFirstMessage(
  check: CapabilityCheck,
  version: string,
  now = Date.now(),
): boolean {
  return (
    check.interactionMode === 'browser_dom' &&
    check.firstMessageAllowed === true &&
    check.failureCode === 'FIRST_REPLY_PENDING' &&
    check.adapterVersion === version &&
    check.checkedAt <= now &&
    now - check.checkedAt < 120_000 &&
    check.pageOpen &&
    check.pageReachable === 'yes' &&
    check.login === 'logged_in' &&
    check.capabilities.canSubmitMessage &&
    check.capabilities.canDetectLogin
  );
}

export function canPrepareSession(
  check: CapabilityCheck,
  version: string,
  now = Date.now(),
): boolean {
  return (
    check.sessionPreparationAllowed === true &&
    check.interactionMode === 'browser_dom' &&
    check.adapterVersion === version &&
    check.checkedAt <= now &&
    now - check.checkedAt < 120_000 &&
    check.pageOpen &&
    check.pageReachable === 'yes' &&
    check.login === 'logged_in' &&
    check.capabilities.canSubmitMessage &&
    check.capabilities.canDetectLogin
  );
}

/** Read-only polling remains possible while the reply is being generated. It never authorizes a send. */
export function canObserveResponse(
  check: CapabilityCheck,
  version: string,
  now = Date.now(),
): boolean {
  return (
    check.interactionMode === 'browser_dom' &&
    check.adapterVersion === version &&
    check.checkedAt <= now &&
    now - check.checkedAt < 120_000 &&
    check.pageOpen &&
    check.pageReachable === 'yes' &&
    check.login === 'logged_in' &&
    check.capabilities.canSubmitMessage &&
    check.capabilities.canDetectLogin &&
    [
      undefined,
      'FIRST_REPLY_PENDING',
      'PAGE_BUSY',
      'OUTPUT_NOT_FOUND',
      'COMPLETION_NOT_FOUND',
    ].includes(check.failureCode)
  );
}
