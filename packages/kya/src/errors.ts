/** Fail-closed CLI / client errors — never silent allow-all. */

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

  constructor(status: number, message: string, body?: unknown) {
    super(message, `HTTP_${status}`, 1);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export class UsageError extends KyaError {
  constructor(message: string) {
    super(message, "USAGE", 2);
    this.name = "UsageError";
  }
}
