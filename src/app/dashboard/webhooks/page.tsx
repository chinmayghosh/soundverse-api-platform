import { desc, eq } from "drizzle-orm";
import { requireDashboard } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { webhookDeliveries } from "@/server/db/schema";
import { listEndpoints } from "@/server/webhooks/endpoints";
import { WebhooksClient } from "./webhooks-client";

export default async function WebhooksPage() {
  const ctx = await requireDashboard();
  const endpoints = await listEndpoints(ctx.accountId);
  const deliveries = await db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.accountId, ctx.accountId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(30);
  return (
    <WebhooksClient
      endpoints={endpoints.map((e) => ({ id: e.id, url: e.url, createdAt: e.createdAt.toISOString() }))}
      deliveries={deliveries.map((d) => ({
        id: d.id,
        endpointId: d.endpointId,
        eventId: d.eventId,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        lastStatusCode: d.lastStatusCode,
        lastError: d.lastError,
        nextAttemptAt: d.status === "pending" ? d.nextAttemptAt.toISOString() : null,
      }))}
    />
  );
}
