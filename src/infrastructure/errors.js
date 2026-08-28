export const ErrorCode = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  TAB_UNAVAILABLE: "TAB_UNAVAILABLE",
  CONTENT_SCRIPT_UNAVAILABLE: "CONTENT_SCRIPT_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  HTTP_ERROR: "HTTP_ERROR",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  CANCELLED: "CANCELLED"
});

export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export function cancelledError() {
  return new AppError(ErrorCode.CANCELLED, "Operation cancelled");
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}
