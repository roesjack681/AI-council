export class CouncilError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly safeToRetry = false,
  ) {
    super(message);
    this.name = 'CouncilError';
  }
}
export function errorText(error: unknown): string {
  return error instanceof CouncilError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}
export function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new CouncilError('NOT_FOUND', message);
  return value;
}
