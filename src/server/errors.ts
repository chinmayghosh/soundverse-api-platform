// One error shape everywhere:
// { "error": { "type", "code", "message", "request_id" } }

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "idempotency_error"
  | "billing_error"
  | "rate_limit_error"
  | "api_error";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const Errors = {
  invalidRequest: (code: string, message: string) =>
    new ApiError(400, "invalid_request_error", code, message),
  unprocessable: (code: string, message: string) =>
    new ApiError(422, "invalid_request_error", code, message),
  unauthenticated: (code: string, message: string) =>
    new ApiError(401, "authentication_error", code, message),
  forbidden: (code: string, message: string) =>
    new ApiError(403, "permission_error", code, message),
  // Also used for other tenants' resources, so existence is never revealed.
  notFound: (what: string) =>
    new ApiError(404, "not_found_error", "resource_not_found", `No such ${what}.`),
  conflict: (code: string, message: string) =>
    new ApiError(409, "invalid_request_error", code, message),
  rateLimited: (code: string, message: string, retryAfterSec: number) =>
    new ApiError(429, "rate_limit_error", code, message, {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))),
    }),
  insufficientCredits: (message: string) =>
    new ApiError(402, "billing_error", "insufficient_credits", message),
};

export function errorBody(err: ApiError, requestId: string) {
  return {
    error: { type: err.type, code: err.code, message: err.message, request_id: requestId },
  };
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  console.error(err);
  return new ApiError(500, "api_error", "internal_error", "An unexpected error occurred.");
}
