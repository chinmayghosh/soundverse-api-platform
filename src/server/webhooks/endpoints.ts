import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { writeAudit } from "../audit/log";
import { db, type Tx } from "../db/client";
import { webhookEndpoints } from "../db/schema";
import { Errors } from "../errors";
import { newId } from "../ids";
import { encryptSecret, newWebhookSecret } from "./crypto";
import { UnsafeUrlError, resolveSafeTarget, type Resolver } from "./ssrf";

export const MAX_ENDPOINTS = 10;
export const EVENT_TYPES = ["generation.succeeded", "generation.failed", "generation.canceled"] as const;

const publicColumns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  description: webhookEndpoints.description,
  createdAt: webhookEndpoints.createdAt,
};

export function serializeEndpoint(e: { id: string; url: string; description: string | null; createdAt: Date }) {
  return {
    id: e.id,
    object: "webhook_endpoint",
    url: e.url,
    description: e.description,
    events: [...EVENT_TYPES],
    created_at: e.createdAt.toISOString(),
  };
}

interface Actor {
  accountId: string;
  userId: string | null;
  apiKeyId?: string;
  ip?: string | null;
}

// Run before opening a transaction: it may do a DNS lookup.
export async function validateWebhookUrl(url: string, resolver?: Resolver) {
  try {
    await resolveSafeTarget(url, { resolver });
  } catch (e) {
    if (e instanceof UnsafeUrlError) {
      throw Errors.unprocessable("invalid_webhook_url", `Webhook URL rejected: ${e.message}.`);
    }
    throw e;
  }
}

// Call validateWebhookUrl first. Runs in the caller's transaction so the
// endpoint, its audit row and (via the API) the idempotency record commit together.
export async function createEndpoint(tx: Tx, actor: Actor, input: { url: string; description?: string }) {
  const secret = newWebhookSecret();
  // Lock the account row so concurrent creates can't exceed the cap.
  await tx.execute(sql`select 1 from accounts where id = ${actor.accountId} for update`);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.accountId, actor.accountId), isNull(webhookEndpoints.deletedAt)));
  if (n >= MAX_ENDPOINTS) {
    throw Errors.conflict("too_many_endpoints", `An account can have at most ${MAX_ENDPOINTS} webhook endpoints.`);
  }
  const [endpoint] = await tx
    .insert(webhookEndpoints)
    .values({
      id: newId("we"),
      accountId: actor.accountId,
      url: input.url,
      description: input.description ?? null,
      secretCiphertext: encryptSecret(secret),
    })
    .returning(publicColumns);
  await writeAudit(tx, {
    accountId: actor.accountId,
    actorUserId: actor.userId,
    action: "webhook.created",
    targetType: "webhook_endpoint",
    targetId: endpoint.id,
    metadata: { url: input.url, viaApiKey: actor.apiKeyId ?? null },
    ip: actor.ip,
  });
  return { endpoint, secret };
}

export async function listEndpoints(accountId: string) {
  return db()
    .select(publicColumns)
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.accountId, accountId), isNull(webhookEndpoints.deletedAt)))
    .orderBy(desc(webhookEndpoints.createdAt));
}

// Soft delete: delivery history stays; pending deliveries to it are dropped
// by the delivery worker.
export async function deleteEndpoint(actor: Actor, id: string) {
  return db().transaction(async (tx) => {
    const [endpoint] = await tx
      .update(webhookEndpoints)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.accountId, actor.accountId),
          isNull(webhookEndpoints.deletedAt),
        ),
      )
      .returning(publicColumns);
    if (!endpoint) throw Errors.notFound("webhook endpoint");
    await writeAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: "webhook.deleted",
      targetType: "webhook_endpoint",
      targetId: endpoint.id,
      metadata: { url: endpoint.url, viaApiKey: actor.apiKeyId ?? null },
      ip: actor.ip,
    });
    return endpoint;
  });
}
