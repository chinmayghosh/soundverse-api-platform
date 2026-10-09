import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Agent, request } from "undici";
import { db } from "../db/client";
import { generations, webhookDeliveries, webhookEndpoints } from "../db/schema";
import { serializeGeneration } from "../generations/serialize";
import { SIGNATURE_HEADER, decryptSecret, signPayload } from "./crypto";
import { UnsafeUrlError, resolveSafeTarget, type ResolvedTarget, type Resolver } from "./ssrf";

// Delay before retry N (after the Nth failed attempt). 13 attempts spanning
// ~24h: an endpoint that is down for 10 minutes gets its event within ~20
// minutes of recovering; one down for a day still gets it.
export const RETRY_SCHEDULE_SEC = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 28800];

export interface DeliveryDeps {
  resolver?: Resolver;
  allowHttp?: boolean;
  allowPrivateHosts?: string[];
  timeoutMs: number;
  schedule: number[];
}

export const defaultDeliveryDeps = (): DeliveryDeps => ({ timeoutMs: 10_000, schedule: RETRY_SCHEDULE_SEC });

type Delivery = typeof webhookDeliveries.$inferSelect;

// Same SKIP LOCKED + lease pattern as the job queue.
export async function claimDueDeliveries(limit = 10): Promise<Delivery[]> {
  const due = db()
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lt(webhookDeliveries.nextAttemptAt, sql`now() + interval '1 millisecond'`),
        or(isNull(webhookDeliveries.leaseUntil), lt(webhookDeliveries.leaseUntil, sql`now()`)),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  return db()
    .update(webhookDeliveries)
    .set({ leaseUntil: sql`now() + interval '60 seconds'` })
    .where(inArray(webhookDeliveries.id, due))
    .returning();
}

export async function deliverDue(deps: DeliveryDeps = defaultDeliveryDeps()): Promise<number> {
  const batch = await claimDueDeliveries();
  await Promise.all(batch.map((d) => deliverOne(d, deps)));
  return batch.length;
}

export async function deliverOne(d: Delivery, deps: DeliveryDeps): Promise<void> {
  const [endpoint] = await db().select().from(webhookEndpoints).where(eq(webhookEndpoints.id, d.endpointId));
  if (!endpoint || endpoint.deletedAt) {
    await record(d, deps, { ok: false, final: true, error: "endpoint deleted" });
    return;
  }

  // Fresh signed audio URL at send time (a retry may be hours later).
  let payload = d.payload as { type: string; data: { id: string } };
  if (payload.type === "generation.succeeded") {
    const [gen] = await db().select().from(generations).where(eq(generations.id, payload.data.id));
    if (gen) payload = { ...payload, data: await serializeGeneration(gen) };
  }
  const body = JSON.stringify(payload);

  let target: ResolvedTarget;
  try {
    // Re-validated on every attempt: DNS may have changed since registration.
    target = await resolveSafeTarget(endpoint.url, deps);
  } catch (e) {
    const msg = e instanceof UnsafeUrlError ? `blocked: ${e.message}` : String(e);
    await record(d, deps, { ok: false, error: msg });
    return;
  }

  try {
    const res = await post(target, body, {
      "Content-Type": "application/json",
      "User-Agent": "Soundverse-Webhooks/1.0",
      [SIGNATURE_HEADER]: signPayload(decryptSecret(endpoint.secretCiphertext), body),
      "Soundverse-Event-Id": d.eventId,
      "Soundverse-Event-Type": d.eventType,
      "Soundverse-Delivery-Attempt": String(d.attempts + 1),
    }, deps.timeoutMs);
    const ok = res >= 200 && res < 300;
    await record(d, deps, { ok, statusCode: res, error: ok ? undefined : `HTTP ${res}` });
  } catch (e) {
    await record(d, deps, { ok: false, error: (e as Error).message?.slice(0, 300) ?? "request failed" });
  }
}

// Connects to the exact address we validated (no second DNS lookup), with
// TLS SNI / Host still set from the URL. undici's request() never follows
// redirects, so a 3xx counts as a failure and can't bounce us to an internal host.
async function post(target: ResolvedTarget, body: string, headers: Record<string, string>, timeoutMs: number) {
  const dispatcher = new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: (_host, opts, cb) => {
        const o = opts as { all?: boolean };
        if (o?.all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [target]);
        else (cb as (e: null, a: string, f: number) => void)(null, target.address, target.family);
      },
    },
  });
  try {
    const res = await request(target.url, {
      method: "POST",
      body,
      headers,
      dispatcher,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    await res.body.dump({ limit: 64 * 1024 }).catch(() => {});
    return res.statusCode;
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

async function record(
  d: Delivery,
  deps: DeliveryDeps,
  r: { ok: boolean; statusCode?: number; error?: string; final?: boolean },
) {
  const attempts = d.attempts + 1;
  const exhausted = r.final || attempts > deps.schedule.length;
  await db()
    .update(webhookDeliveries)
    .set({
      attempts,
      lastStatusCode: r.statusCode ?? null,
      lastError: r.error ?? null,
      leaseUntil: null,
      status: r.ok ? "succeeded" : exhausted ? "failed" : "pending",
      deliveredAt: r.ok ? new Date() : null,
      nextAttemptAt: r.ok || exhausted
        ? d.nextAttemptAt
        : sql`now() + make_interval(secs => ${deps.schedule[attempts - 1]})`,
    })
    .where(eq(webhookDeliveries.id, d.id));
}
