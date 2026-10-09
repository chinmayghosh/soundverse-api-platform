import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { refundGeneration } from "../billing/ledger";
import { db, type Tx } from "../db/client";
import { generations, idempotencyKeys, rateLimitCounters } from "../db/schema";
import { env } from "../env";
import { sleep } from "../providers/mock";
import { defaultResolver, type ProviderResolver } from "../providers/registry";
import { ProviderError } from "../providers/types";
import { putObject } from "../storage/s3";
import { emitGenerationEvent } from "../webhooks/events";

type Job = typeof generations.$inferSelect;

export interface WorkerDeps {
  resolve: ProviderResolver;
  leaseSec: number;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
}

export function defaultDeps(): WorkerDeps {
  const e = env();
  return {
    resolve: defaultResolver,
    leaseSec: e.JOB_LEASE_SEC,
    timeoutMs: e.PROVIDER_TIMEOUT_MS,
    maxAttempts: e.PROVIDER_MAX_ATTEMPTS,
    backoffMs: 2000,
  };
}

// A job claimed this many times without finishing (worker crashes, lost
// leases) is failed and refunded instead of looping forever.
export const MAX_CLAIMS = 3;

/* ------------------------------------------------------------------ */
/* Claiming                                                            */
/* ------------------------------------------------------------------ */

// FOR UPDATE SKIP LOCKED: concurrent workers each grab a different queued job
// without blocking each other, and no job is handed out twice. Claiming bumps
// `attempts`, which then acts as a fencing token for every later write.
export async function claimNext(leaseSec: number): Promise<Job | null> {
  const next = db()
    .select({ id: generations.id })
    .from(generations)
    .where(eq(generations.status, "queued"))
    .orderBy(asc(generations.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  const [job] = await db()
    .update(generations)
    .set({
      status: "running",
      attempts: sql`${generations.attempts} + 1`,
      leaseUntil: sql`now() + make_interval(secs => ${leaseSec})`,
      startedAt: sql`coalesce(${generations.startedAt}, now())`,
    })
    .where(inArray(generations.id, next))
    .returning();
  return job ?? null;
}

// Fenced: only the current claim (status running + same attempt) may write.
const owns = (job: Job) =>
  and(eq(generations.id, job.id), eq(generations.status, "running"), eq(generations.attempts, job.attempts));

async function extendLease(job: Job, leaseSec: number): Promise<boolean> {
  const rows = await db()
    .update(generations)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${leaseSec})` })
    .where(owns(job))
    .returning({ id: generations.id });
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Processing                                                          */
/* ------------------------------------------------------------------ */

export type Outcome = "succeeded" | "failed" | "abandoned";

class LostOwnership extends Error {}

export async function processJob(job: Job, deps: WorkerDeps): Promise<Outcome> {
  // Aborted when the job is canceled or our lease is taken over; checked by
  // a heartbeat that also keeps the lease alive while the provider works.
  const owner = new AbortController();
  const heartbeat = setInterval(
    () => {
      extendLease(job, deps.leaseSec)
        .then((ok) => ok || owner.abort(new LostOwnership()))
        .catch(() => {}); // transient DB error: the next beat retries
    },
    Math.max(1000, (deps.leaseSec * 1000) / 3),
  );

  let providerRequestId = job.providerRequestId;
  let lastError = new ProviderError("provider_error", "Generation failed.");
  try {
    const provider = deps.resolve(job.provider);
    for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
      const timeout = AbortSignal.timeout(deps.timeoutMs);
      try {
        const result = await provider.generate({
          jobId: job.id,
          model: job.model,
          prompt: job.prompt,
          durationSec: job.durationSec,
          instrumental: job.instrumental,
          signal: AbortSignal.any([owner.signal, timeout]),
          providerRequestId,
          onSubmitted: async (id) => {
            providerRequestId = id;
            await db().update(generations).set({ providerRequestId: id }).where(owns(job));
          },
        });
        if (owner.signal.aborted) return "abandoned";
        const key = `audio/${job.accountId}/${job.id}.${result.format}`;
        await putObject(key, result.audio, result.contentType);
        return (await finishSucceeded(job, key, result)) ? "succeeded" : "abandoned";
      } catch (e) {
        if (owner.signal.aborted) return "abandoned"; // canceled or lease lost
        lastError = toProviderError(e, timeout.aborted);
        // An upstream error means that provider request is dead; a timeout may
        // still complete, so keep its id and resume polling it next attempt.
        if (lastError.code !== "provider_timeout") providerRequestId = null;
        if (!lastError.retryable || attempt === deps.maxAttempts) break;
        await sleep(deps.backoffMs * 2 ** (attempt - 1), owner.signal).catch(() => {});
        if (owner.signal.aborted) return "abandoned";
      }
    }
  } catch (e) {
    lastError = toProviderError(e, false);
  } finally {
    clearInterval(heartbeat);
  }
  return (await finishFailed(job, lastError.code, lastError.message)) ? "failed" : "abandoned";
}

function toProviderError(e: unknown, timedOut: boolean): ProviderError {
  if (e instanceof ProviderError) return e;
  if (timedOut) return new ProviderError("provider_timeout", "The music model did not respond in time.");
  console.error("provider call failed", e);
  return new ProviderError("provider_error", "The music model returned an error.");
}

async function finishSucceeded(
  job: Job,
  outputKey: string,
  result: { format: string; durationSec: number },
): Promise<boolean> {
  return db().transaction(async (tx) => {
    const [done] = await tx
      .update(generations)
      .set({
        status: "succeeded",
        outputKey,
        outputFormat: result.format,
        outputDurationSec: result.durationSec.toFixed(2),
        completedAt: new Date(),
        leaseUntil: null,
      })
      .where(owns(job))
      .returning();
    if (!done) return false; // canceled or reclaimed meanwhile; their state wins
    await emitGenerationEvent(tx, "generation.succeeded", done);
    return true;
  });
}

// Customer got nothing, so the charge is reversed in the same transaction.
async function finishFailed(job: Job, code: string, message: string): Promise<boolean> {
  return db().transaction(async (tx) => failInTx(tx, job, code, message));
}

async function failInTx(tx: Tx, job: Job, code: string, message: string): Promise<boolean> {
  const [done] = await tx
    .update(generations)
    .set({ status: "failed", errorCode: code, errorMessage: message, completedAt: new Date(), leaseUntil: null })
    .where(owns(job))
    .returning();
  if (!done) return false;
  await refundGeneration(tx, job.id);
  await emitGenerationEvent(tx, "generation.failed", done);
  return true;
}

/* ------------------------------------------------------------------ */
/* Recovery and housekeeping                                           */
/* ------------------------------------------------------------------ */

// A running job whose lease expired belongs to a worker that died (or hung).
// Put it back in the queue; after MAX_CLAIMS, fail and refund it.
export async function reapExpiredLeases(): Promise<{ requeued: number; failed: number }> {
  return db().transaction(async (tx) => {
    const expired = await tx
      .select()
      .from(generations)
      .where(and(eq(generations.status, "running"), lt(generations.leaseUntil, sql`now()`)))
      .limit(100)
      .for("update", { skipLocked: true });
    let requeued = 0;
    let failed = 0;
    for (const job of expired) {
      if (job.attempts >= MAX_CLAIMS) {
        if (await failInTx(tx, job, "worker_lost", "The job was interrupted too many times.")) failed++;
      } else {
        await tx.update(generations).set({ status: "queued", leaseUntil: null }).where(owns(job));
        requeued++;
      }
    }
    return { requeued, failed };
  });
}

export async function housekeeping() {
  await db().delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, sql`now() - interval '24 hours'`));
  await db().delete(rateLimitCounters).where(lt(rateLimitCounters.windowStart, sql`now() - interval '2 days'`));
}
