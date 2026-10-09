import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/* ------------------------------------------------------------------ */
/* Better Auth (dashboard login only). Prefixed so "account" here is   */
/* never confused with our tenant `accounts` table.                    */
/* ------------------------------------------------------------------ */

export const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
});

export const authAccounts = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const authVerifications = pgTable("auth_verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Tenancy and plans                                                   */
/* ------------------------------------------------------------------ */

export const licenseEnum = pgEnum("license", ["royalty_free", "sync", "full_ownership"]);
export const keyModeEnum = pgEnum("key_mode", ["test", "live"]);
export const memberRoleEnum = pgEnum("member_role", ["owner", "developer"]);

// Plans are rows, not code: editing a row or an account's plan_id changes
// limits immediately, without a deploy.
export const plans = pgTable("plans", {
  id: text("id").primaryKey(), // sandbox | starter | growth | custom ids in tests
  name: text("name").notNull(),
  monthlyCredits: integer("monthly_credits").notNull(),
  parallelLimit: integer("parallel_limit").notNull(),
  reqPerHour: integer("req_per_hour").notNull(),
  reqPerDay: integer("req_per_day").notNull(),
  licenses: licenseEnum("licenses").array().notNull(),
  overageAllowed: boolean("overage_allowed").notNull(),
  liveKeysAllowed: boolean("live_keys_allowed").notNull(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(), // acct_...
  name: text("name").notNull(),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId] }),
    // One account per user keeps dashboard session -> tenant unambiguous.
    uniqueIndex("memberships_user_uq").on(t.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* API keys                                                            */
/* ------------------------------------------------------------------ */

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // key_...
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mode: keyModeEnum("mode").notNull(),
    // Public lookup handle, e.g. "sv_live_8f3k2a9q". Safe to show and log.
    prefix: text("prefix").notNull().unique(),
    // HMAC-SHA256(pepper, full secret). The secret itself is never stored.
    secretHash: text("secret_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    // Set on the old key during rotation: valid until this instant.
    expiresAt: ts("expires_at"),
    replacedByKeyId: text("replaced_by_key_id"),
  },
  (t) => [index("api_keys_account_idx").on(t.accountId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Generations (also the job queue)                                    */
/* ------------------------------------------------------------------ */

export const generationStatusEnum = pgEnum("generation_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export const generations = pgTable(
  "generations",
  {
    id: text("id").primaryKey(), // gen_...
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    mode: keyModeEnum("mode").notNull(),
    status: generationStatusEnum("status").notNull().default("queued"),
    prompt: text("prompt").notNull(),
    durationSec: integer("duration_sec").notNull(),
    license: licenseEnum("license").notNull(),
    instrumental: boolean("instrumental").notNull(),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    creditsCharged: integer("credits_charged").notNull(),
    provider: text("provider").notNull(), // fixed at creation; never silently swapped
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    outputKey: text("output_key"),
    outputDurationSec: numeric("output_duration_sec", { precision: 8, scale: 2 }),
    outputFormat: text("output_format"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: ts("lease_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("generations_account_created_idx").on(t.accountId, t.createdAt),
    // Worker claim order and parallel-limit counting.
    index("generations_queue_idx")
      .on(t.status, t.createdAt)
      .where(sql`status in ('queued','running')`),
  ],
);

/* ------------------------------------------------------------------ */
/* Ledger: append-only. A trigger (custom migration) rejects UPDATE   */
/* and DELETE, so balances are always Σ of immutable rows.            */
/* ------------------------------------------------------------------ */

export const ledgerKindEnum = pgEnum("ledger_kind", ["debit", "refund"]);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(), // led_...
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    generationId: text("generation_id")
      .notNull()
      .references(() => generations.id),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    period: text("period").notNull(), // "YYYY-MM", UTC
    kind: ledgerKindEnum("kind").notNull(),
    // Debits are positive; refunds are negative. Split between plan
    // allowance and billable overage at the moment of the debit.
    allowanceCredits: integer("allowance_credits").notNull(),
    overageCredits: integer("overage_credits").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ledger_account_period_idx").on(t.accountId, t.period),
    // At most one debit and one refund per generation.
    uniqueIndex("ledger_generation_kind_uq").on(t.generationId, t.kind),
  ],
);

/* ------------------------------------------------------------------ */
/* Idempotency and rate limits                                         */
/* ------------------------------------------------------------------ */

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(), // sha256(method, path, body)
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    window: text("window").notNull(), // "hour" | "day"
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.window, t.windowStart] })],
);

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: text("id").primaryKey(), // we_...
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  // AES-256-GCM(WEBHOOK_SECRET_ENC_KEY, whsec_...). We must be able to sign,
  // so it is encrypted rather than hashed; shown in full only at creation.
  secretCiphertext: text("secret_ciphertext").notNull(),
  description: text("description"),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const deliveryStatusEnum = pgEnum("delivery_status", [
  "pending",
  "succeeded",
  "failed",
]);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(), // whd_...
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(), // evt_..., stable across retries
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    leaseUntil: ts("lease_until"),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    deliveredAt: ts("delivered_at"),
  },
  (t) => [
    index("webhook_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
    uniqueIndex("webhook_deliveries_event_endpoint_uq").on(t.eventId, t.endpointId),
  ],
);

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(), // aud_...
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"), // null for system actions (e.g. set-plan script)
    action: text("action").notNull(), // key.created | key.rotated | key.revoked | plan.changed | ...
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_account_created_idx").on(t.accountId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Spend guard for paid providers: calls made, capped by env.          */
/* ------------------------------------------------------------------ */

export const providerUsage = pgTable("provider_usage", {
  provider: text("provider").primaryKey(),
  calls: integer("calls").notNull().default(0),
});
