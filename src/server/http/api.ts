import type { z } from "zod";
import { ApiError, Errors, errorBody, toApiError } from "../errors";
import { newId } from "../ids";
import { authenticate, type AuthedKey, type Scope } from "../keys/service";
import { consumeRateLimit, rateLimitHeaders } from "../limits/rateLimit";

export interface ApiContext {
  req: Request;
  url: URL;
  requestId: string;
  key: AuthedKey;
}

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  // What an idempotent replay returns, if it must differ from `body`
  // (e.g. to avoid storing a one-time secret).
  replayBody?: unknown;
}

type Handler<P> = (ctx: ApiContext, params: P) => Promise<ApiResult>;

// Every /v1 route is wrapped in this. Order matters:
//   1. request id   2. API key auth   3. account rate limit   4. scope check
//   5. handler
// Rate limiting comes before the scope check so that every authenticated
// request counts, including ones rejected later. Rate-limit headers are
// attached to every response after step 3, errors included. Any thrown
// ApiError becomes the single error shape.
export function apiRoute<P = Record<string, never>>(scope: Scope, handler: Handler<P>) {
  return async (req: Request, routeCtx?: { params: Promise<P> }): Promise<Response> => {
    const requestId = newId("req");
    const headers = new Headers({ "X-Request-Id": requestId, "Cache-Control": "no-store" });
    try {
      const key = await authenticate(req.headers.get("authorization"));
      const limit = await consumeRateLimit(key.accountId);
      for (const [k, v] of Object.entries(rateLimitHeaders(limit))) headers.set(k, v);
      if (!key.scopes.includes(scope)) {
        throw Errors.forbidden("insufficient_scope", `This API key lacks the "${scope}" scope.`);
      }
      const params = routeCtx ? await routeCtx.params : ({} as P);
      const result = await handler({ req, url: new URL(req.url), requestId, key }, params);
      for (const [k, v] of Object.entries(result.headers ?? {})) headers.set(k, v);
      return Response.json(result.body, { status: result.status, headers });
    } catch (e) {
      const err = toApiError(e);
      for (const [k, v] of Object.entries(err.headers)) headers.set(k, v);
      return Response.json(errorBody(err, requestId), { status: err.status, headers });
    }
  };
}

export async function readRawJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw Errors.invalidRequest("invalid_json", "Request body must be valid JSON.");
  }
}

export async function readJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  return parseOrThrow(schema, await readRawJson(req));
}

export function parseOrThrow<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new ApiError(
      400,
      "invalid_request_error",
      "invalid_parameter",
      path ? `${path}: ${issue.message}` : issue.message,
    );
  }
  return parsed.data;
}
