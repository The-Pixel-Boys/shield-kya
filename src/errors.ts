/** Fail-closed CLI / client errors - never silent allow-all. */

export class KyaError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = "KYA_ERROR", exitCode = 1) {
    super(message);
    this.name = "KyaError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class AuthRequiredError extends KyaError {
  constructor(message = "KYA_API_KEY is required against an authenticated control plane") {
    super(message, "AUTH_REQUIRED", 1);
    this.name = "AuthRequiredError";
  }
}

export class HttpError extends KyaError {
  readonly status: number;
  readonly body: unknown;
  /** Raw Retry-After header of the response, when the plane sent one. */
  readonly retryAfter: string | undefined;

  constructor(status: number, message: string, body?: unknown, retryAfter?: string) {
    super(message, `HTTP_${status}`, 1);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export class UsageError extends KyaError {
  constructor(message: string) {
    super(message, "USAGE", 2);
    this.name = "UsageError";
  }
}

/** Client-visible error text. Never forwards unknown Error.message (stack-derived). */
export function clientSafeError(err: unknown): string {
  if (err instanceof HttpError) {
    return `control plane HTTP ${err.status}`;
  }
  // The timeout text names the plane URL and CLI hints. An MCP client gets neither.
  if (err instanceof KyaError && err.code === "PLANE_HTTP_TIMEOUT") {
    return "control plane timeout";
  }
  // Fixed text: never the plane URL or the 503 body.
  if (err instanceof KyaError && err.code === "PLANE_BUSY") {
    return "approval service busy; retry later";
  }
  if (err instanceof KyaError) {
    return err.message;
  }
  return "request failed";
}
