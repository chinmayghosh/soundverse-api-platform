import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { LICENSES } from "./billing/pricing";
import { CreateGenerationInput } from "./generations/create";
import { GENERATION_STATUSES } from "./generations/queries";
import { EVENT_TYPES } from "./webhooks/endpoints";

extendZodWithOpenApi(z);

// Request schemas are the same objects the handlers validate with; response
// schemas are checked against real responses in tests/integration/openapi.test.ts.

const ts = z.string().openapi({ format: "date-time", example: "2026-10-09T08:30:00.000Z" });

export const ErrorSchema = z
  .object({
    error: z.object({
      type: z.enum([
        "invalid_request_error",
        "authentication_error",
        "permission_error",
        "not_found_error",
        "idempotency_error",
        "billing_error",
        "rate_limit_error",
        "api_error",
      ]),
      code: z.string().openapi({ example: "parallel_limit_reached" }),
      message: z.string(),
      request_id: z.string().openapi({ example: "req_01J9ZK3XQ2V8M6N4P0R7T5W1Y3" }),
    }),
  })
  .openapi("Error");

export const GenerationSchema = z
  .object({
    id: z.string().openapi({ example: "gen_01J9ZK3XQ2V8M6N4P0R7T5W1Y3" }),
    object: z.literal("generation"),
    status: z.enum(GENERATION_STATUSES),
    mode: z.enum(["test", "live"]).openapi({ description: "test keys use a mock model and are never charged" }),
    prompt: z.string(),
    duration_sec: z.number().int(),
    license: z.enum(LICENSES),
    instrumental: z.boolean(),
    metadata: z.record(z.string(), z.string()),
    credits_charged: z.number().int().openapi({ description: "0 for test-mode jobs" }),
    model: z.string().openapi({ example: "fal/minimax-music-v2.6", description: "Fixed at creation; never silently substituted" }),
    output: z
      .object({
        audio_url: z.string().nullable().openapi({ description: "Signed URL; expires (see audio_url_expires_at). Re-fetch the job for a fresh one." }),
        audio_url_expires_at: ts.nullable(),
        duration_sec: z.number().nullable(),
        format: z.string().nullable().openapi({ example: "mp3" }),
      })
      .nullable(),
    error: z.object({ code: z.string(), message: z.string().nullable() }).nullable(),
    created_at: ts,
    started_at: ts.nullable(),
    completed_at: ts.nullable(),
  })
  .openapi("Generation");

export const GenerationListSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(GenerationSchema),
    has_more: z.boolean(),
    next_cursor: z.string().nullable().openapi({ description: "Pass as starting_after to get the next page" }),
  })
  .openapi("GenerationList");

export const UsageSchema = z
  .object({
    object: z.literal("usage"),
    period: z.string().openapi({ example: "2026-10" }),
    period_start: ts,
    period_end: ts,
    plan: z.object({
      id: z.string(),
      name: z.string(),
      monthly_credits: z.number().int(),
      parallel_limit: z.number().int(),
      requests_per_hour: z.number().int(),
      requests_per_day: z.number().int(),
      licenses: z.array(z.enum(LICENSES)),
      overage_allowed: z.boolean(),
    }),
    credits: z.object({
      allowance: z.number().int(),
      used: z.number().int(),
      remaining: z.number().int(),
      overage: z.number().int().openapi({ description: "Credits beyond the allowance, billed separately (Growth)" }),
    }),
    parallel: z.object({ limit: z.number().int(), live_in_progress: z.number().int(), test_in_progress: z.number().int() }),
    by_key: z.array(z.object({ api_key_id: z.string(), prefix: z.string(), name: z.string(), credits: z.number().int() })),
    by_day: z.array(z.object({ day: z.string(), credits: z.number().int() })),
  })
  .openapi("Usage");

const EndpointBase = {
  id: z.string().openapi({ example: "we_01J9ZK3XQ2V8M6N4P0R7T5W1Y3" }),
  object: z.literal("webhook_endpoint"),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.enum(EVENT_TYPES)),
  created_at: ts,
};
export const WebhookEndpointSchema = z.object(EndpointBase).openapi("WebhookEndpoint");
export const WebhookEndpointCreatedSchema = z
  .object({
    ...EndpointBase,
    secret: z.string().nullable().openapi({
      example: "whsec_8f3k2a9q...",
      description: "Signing secret. Returned once, on creation; null on idempotent replays.",
    }),
  })
  .openapi("WebhookEndpointCreated");

export const WebhookEventSchema = z
  .object({
    id: z.string().openapi({ example: "evt_01J9ZK3XQ2V8M6N4P0R7T5W1Y3", description: "Stable across retries; use it to dedupe" }),
    object: z.literal("event"),
    type: z.enum(EVENT_TYPES),
    created_at: ts,
    data: GenerationSchema,
  })
  .openapi("WebhookEvent");

export function buildOpenApiDocument() {
  const r = new OpenAPIRegistry();
  const bearer = r.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Secret API key: sv_test_… (mock model, free) or sv_live_… (real model, billed).",
  });
  const security = [{ [bearer.name]: [] }];
  const json = (schema: z.ZodType, description: string) => ({ description, content: { "application/json": { schema } } });
  const rateHeaders = {
    "X-RateLimit-Limit": { schema: { type: "integer" as const }, description: "Limit of the window closest to exhaustion" },
    "X-RateLimit-Remaining": { schema: { type: "integer" as const } },
    "X-RateLimit-Reset": { schema: { type: "integer" as const }, description: "Unix time the window resets" },
    "X-RateLimit-Window": { schema: { type: "string" as const, enum: ["hour", "day"] } },
    "X-Request-Id": { schema: { type: "string" as const } },
  };
  const errors = {
    400: json(ErrorSchema, "Invalid request (invalid_parameter, invalid_json, invalid_idempotency_key)"),
    401: json(ErrorSchema, "Missing, invalid, revoked or expired API key"),
    403: json(ErrorSchema, "Insufficient scope, or not allowed on your plan"),
    429: {
      ...json(ErrorSchema, "hourly_rate_limit_exceeded, daily_rate_limit_exceeded or parallel_limit_reached. See Retry-After."),
      headers: { "Retry-After": { schema: { type: "integer" as const } } },
    },
  };
  const idempotencyHeader = z.object({
    "idempotency-key": z.string().max(255).optional().openapi({
      description: "Retries with the same key and body return the original response (Idempotent-Replayed: true) and never create or bill twice. Same key + different body = 422. Keys are kept for 24h.",
    }),
  });
  const idParam = z.object({ id: z.string() });

  r.registerPath({
    method: "post",
    path: "/v1/generations",
    summary: "Start a generation",
    description:
      "Validates license, parallel slots and credits, reserves the credits and queues the job atomically. Cost: credits per license (royalty_free 1, sync 6, full_ownership 14) × each started 60 s of requested duration.",
    security,
    request: { headers: idempotencyHeader, body: { content: { "application/json": { schema: CreateGenerationInput } } } },
    responses: {
      202: { ...json(GenerationSchema, "Job accepted (status queued)"), headers: rateHeaders },
      ...errors,
      402: json(ErrorSchema, "insufficient_credits: allowance exhausted and the plan has no overage"),
      422: json(ErrorSchema, "idempotency_key_reused"),
    },
  });
  r.registerPath({
    method: "get",
    path: "/v1/generations",
    summary: "List generations (newest first)",
    security,
    request: {
      query: z.object({
        limit: z.number().int().min(1).max(100).optional().openapi({ example: 20 }),
        status: z.enum(GENERATION_STATUSES).optional(),
        starting_after: z.string().optional().openapi({ description: "next_cursor from the previous page" }),
      }),
    },
    responses: { 200: { ...json(GenerationListSchema, "A page of generations"), headers: rateHeaders }, ...errors },
  });
  r.registerPath({
    method: "get",
    path: "/v1/generations/{id}",
    summary: "Get a generation",
    description: "When succeeded, output.audio_url is a freshly signed URL. Prefer webhooks to polling; if you poll, every 5 s or slower (polls count toward your rate limit).",
    security,
    request: { params: idParam },
    responses: {
      200: { ...json(GenerationSchema, "The generation"), headers: rateHeaders },
      ...errors,
      404: json(ErrorSchema, "Not found (also returned for other accounts' jobs)"),
    },
  });
  r.registerPath({
    method: "post",
    path: "/v1/generations/{id}/cancel",
    summary: "Cancel a queued or running generation",
    description: "Queued: canceled with a full refund. Running: canceled, not refunded (the model was already invoked). Already canceled: returned as-is.",
    security,
    request: { params: idParam, headers: idempotencyHeader },
    responses: {
      200: json(GenerationSchema, "The canceled generation"),
      ...errors,
      404: json(ErrorSchema, "Not found"),
      409: json(ErrorSchema, "generation_not_cancelable: already succeeded or failed"),
    },
  });
  r.registerPath({
    method: "get",
    path: "/v1/usage",
    summary: "Usage and remaining allowance for the current period",
    security,
    responses: { 200: json(UsageSchema, "Usage for the current UTC calendar month"), ...errors },
  });
  r.registerPath({
    method: "post",
    path: "/v1/webhook_endpoints",
    summary: "Register a webhook endpoint",
    description: "URLs must resolve only to public addresses (no private, loopback, link-local or metadata IPs); re-checked on every delivery. Max 10 endpoints.",
    security,
    request: {
      headers: idempotencyHeader,
      body: { content: { "application/json": { schema: z.object({ url: z.string(), description: z.string().max(200).optional() }) } } },
    },
    responses: {
      201: json(WebhookEndpointCreatedSchema, "Created; includes the signing secret once"),
      ...errors,
      409: json(ErrorSchema, "too_many_endpoints"),
      422: json(ErrorSchema, "invalid_webhook_url"),
    },
  });
  r.registerPath({
    method: "get",
    path: "/v1/webhook_endpoints",
    summary: "List webhook endpoints",
    security,
    responses: {
      200: json(z.object({ object: z.literal("list"), data: z.array(WebhookEndpointSchema), has_more: z.boolean() }), "Endpoints"),
      ...errors,
    },
  });
  r.registerPath({
    method: "delete",
    path: "/v1/webhook_endpoints/{id}",
    summary: "Delete a webhook endpoint",
    security,
    request: { params: idParam },
    responses: { 200: json(WebhookEndpointSchema.extend({ deleted: z.literal(true) }), "Deleted"), ...errors, 404: json(ErrorSchema, "Not found") },
  });
  r.registerWebhook({
    method: "post",
    path: "generation.succeeded | generation.failed | generation.canceled",
    summary: "Event delivered to your endpoint",
    description:
      "Header Soundverse-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${raw body}`)>. Verify over the raw body, reject if |now - t| > 300 s, dedupe on event id. Respond 2xx within 10 s; otherwise we retry with backoff for ~24 h.",
    request: { body: { content: { "application/json": { schema: WebhookEventSchema } } } },
    responses: { 200: { description: "Acknowledged" } },
  });

  return new OpenApiGeneratorV31(r.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Soundverse Music Generation API",
      version: "1.0.0",
      description:
        "Generate music from a prompt. Asynchronous: create a job, then receive a webhook or poll. All errors share one shape: { error: { type, code, message, request_id } }.",
    },
    servers: [{ url: "http://localhost:3000" }],
  });
}
