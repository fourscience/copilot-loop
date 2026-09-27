/**
 * Categorised error model. Every failure that can stop or block the loop is
 * expressed as a LoopError with one of these codes so it can be logged,
 * persisted and shown to the user without losing context.
 */
export const ERROR_CODES = [
  'CONFIGURATION_ERROR',
  'MODEL_UNAVAILABLE',
  'MODEL_REQUEST_FAILED',
  'TOOL_FAILED',
  'GATE_FAILED',
  'TASK_INVALID',
  'LOOP_LIMIT',
  'REPEATED_FAILURE',
  'USER_CANCELLED',
  'WORKSPACE_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class LoopError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LoopError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }
}

export function isLoopError(value: unknown): value is LoopError {
  return value instanceof LoopError;
}

/** Normalises any thrown value into a LoopError, preserving the original as `cause`. */
export function toLoopError(value: unknown, fallback: ErrorCode, context?: string): LoopError {
  if (isLoopError(value)) {
    return value;
  }
  if (isAbortError(value)) {
    return new LoopError('USER_CANCELLED', context ? `${context}: cancelled` : 'Cancelled', undefined, { cause: value });
  }
  const message = value instanceof Error ? value.message : String(value);
  return new LoopError(fallback, context ? `${context}: ${message}` : message, undefined, { cause: value });
}

export function isAbortError(value: unknown): boolean {
  return value instanceof Error && (value.name === 'AbortError' || value.name === 'Canceled' || value.name === 'CancellationError');
}

export function throwIfAborted(signal: AbortSignal | undefined, context = 'Operation'): void {
  if (signal?.aborted) {
    throw new LoopError('USER_CANCELLED', `${context} cancelled`);
  }
}
