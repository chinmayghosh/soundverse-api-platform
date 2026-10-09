import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../db/client";
import { generations, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { serializeGeneration } from "../generations/serialize";
import { newId } from "../ids";

export type EventType = "generation.succeeded" | "generation.failed" | "generation.canceled";

// Called inside the same transaction as the state change it announces, so an
// event exists if and only if the change committed (transactional outbox).
// One delivery row per active endpoint; the delivery worker sends them.
export async function emitGenerationEvent(
  tx: Tx,
  type: EventType,
  gen: typeof generations.$inferSelect,
) {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.accountId, gen.accountId), isNull(webhookEndpoints.deletedAt)));
  if (endpoints.length === 0) return;

  const eventId = newId("evt");
  // The signed audio URL is minted at delivery time, not here: a retry up to
  // a day later must not carry an already-expired URL.
  const payload = {
    id: eventId,
    object: "event",
    type,
    created_at: new Date().toISOString(),
    data: await serializeGeneration(gen, { withAudioUrl: false }),
  };
  await tx.insert(webhookDeliveries).values(
    endpoints.map((e) => ({
      id: newId("whd"),
      endpointId: e.id,
      accountId: gen.accountId,
      eventId,
      eventType: type,
      payload,
    })),
  );
}
