/**
 * Typed errors raised by toolbox checks. Every rejection carries a stable code so that an LLM reading
 * the tool result, and the test suite, can match on the reason without parsing prose.
 */
export type ToolboxErrorCode =
  | 'PATH_INVALID'
  | 'PATH_OUTSIDE_ROOT'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'BINARY_FILE'
  | 'SIZE_CAP'
  | 'WRITE_DISABLED'
  | 'SQL_REJECTED'
  | 'SQL_ERROR'
  | 'UNKNOWN_DATABASE'
  | 'UNKNOWN_TABLE'
  | 'URL_INVALID'
  | 'HOST_NOT_ALLOWED'
  | 'FETCH_FAILED'
  | 'TIMEOUT'
  | 'BINARY_CONTENT'
  | 'INVALID_ARGUMENT'
  | 'CONFIG_INVALID';

export class ToolboxError extends Error {
  override readonly name = 'ToolboxError';

  constructor(
    readonly code: ToolboxErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** Rendered as `[CODE] message`; this exact shape is what tool results and audit lines contain. */
  override toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}

export function isToolboxError(value: unknown): value is ToolboxError {
  return value instanceof ToolboxError;
}

/** Message for an unknown thrown value without leaking stack traces to the model. */
export function describeError(err: unknown): string {
  if (isToolboxError(err)) return err.toString();
  if (err instanceof Error) return `[INTERNAL] ${err.message}`;
  return `[INTERNAL] ${String(err)}`;
}
