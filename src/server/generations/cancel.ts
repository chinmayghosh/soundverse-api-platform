import { and, eq } from "drizzle-orm";
import { refundGeneration } from "../billing/ledger";
import type { Tx } from "../db/client";
import { generations } from "../db/schema";
import { Errors } from "../errors";
import { emitGenerationEvent } from "../webhooks/events";

// - queued   -> canceled, full refund (the model was never called).
// - running  -> canceled, no refund: the provider has already been paid for
//               the work. The worker sees the status change on its next
//               heartbeat, aborts, and its fenced writes no longer apply.
// - canceled -> returned as-is (cancel is idempotent).
// - succeeded / failed -> 409, a finished job can't be canceled.
//
// The row lock serializes this against the worker's claim and finish, so
// "canceled" and "succeeded" can't both win.
export async function cancelGeneration(tx: Tx, accountId: string, id: string) {
  const [job] = await tx
    .select()
    .from(generations)
    .where(and(eq(generations.id, id), eq(generations.accountId, accountId)))
    .for("update");
  if (!job) throw Errors.notFound("generation");
  if (job.status === "canceled") return job;
  if (job.status === "succeeded" || job.status === "failed") {
    throw Errors.conflict("generation_not_cancelable", `This generation already ${job.status}.`);
  }

  const [canceled] = await tx
    .update(generations)
    .set({ status: "canceled", completedAt: new Date(), leaseUntil: null })
    .where(eq(generations.id, job.id))
    .returning();
  if (job.status === "queued") await refundGeneration(tx, job.id);
  await emitGenerationEvent(tx, "generation.canceled", canceled);
  return canceled;
}
