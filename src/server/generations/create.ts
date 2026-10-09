import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { periodConsumption, recordDebit, splitCharge } from "../billing/ledger";
import { LICENSES, creditCost, periodOf } from "../billing/pricing";
import type { Tx } from "../db/client";
import { accounts, generations, plans } from "../db/schema";
import { Errors } from "../errors";
import { newId } from "../ids";
import type { AuthedKey } from "../keys/service";
import { modelFor } from "../providers/registry";

export const MAX_DURATION_SEC = 240;

export const CreateGenerationInput = z.object({
  // Leaves room for the duration hint within the model's 2,000-char prompt limit.
  prompt: z.string().trim().min(1).max(1500),
  duration_sec: z.number().int().min(5).max(MAX_DURATION_SEC).default(30),
  // Defaults to the cheapest license, which grants the fewest rights.
  license: z.enum(LICENSES).default("royalty_free"),
  instrumental: z.boolean().default(true),
  metadata: z
    .record(z.string().min(1).max(40), z.string().max(500))
    .refine((m) => Object.keys(m).length <= 20, "at most 20 keys")
    .default({}),
});
export type CreateGenerationInput = z.infer<typeof CreateGenerationInput>;

// Seconds a client should wait before retrying at the parallel limit. Jobs
// take tens of seconds, so there is no exact moment a slot frees up.
const PARALLEL_RETRY_AFTER_SEC = 5;

// Must run inside the caller's transaction (see withIdempotency).
//
// Correctness under concurrency comes from one row lock: every create for an
// account first takes `SELECT … FOR UPDATE` on that account's row. Creates for
// the same account therefore run one at a time, and each sees the jobs and
// ledger rows committed by the previous one. Checks and writes below are a
// plain read-then-write sequence that is safe only because of that lock.
// Different accounts never block each other.
export async function createGeneration(tx: Tx, key: AuthedKey, input: CreateGenerationInput) {
  const [row] = await tx
    .select({ plan: plans })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .where(eq(accounts.id, key.accountId))
    .for("update", { of: accounts });
  if (!row) throw Errors.notFound("account");
  const { plan } = row;

  // 1. Rights: is this license sold on the current plan?
  if (!plan.licenses.includes(input.license)) {
    throw Errors.forbidden(
      "license_not_in_plan",
      `The ${plan.name} plan does not include the "${input.license}" license. Available: ${plan.licenses.join(", ")}.`,
    );
  }
  if (key.mode === "live" && !plan.liveKeysAllowed) {
    throw Errors.forbidden("live_keys_not_in_plan", `The ${plan.name} plan only allows test keys.`);
  }
  // ...and can the model that will run this job back that license?
  const model = modelFor(key.mode);
  if (!model.licenses.includes(input.license)) {
    throw Errors.forbidden(
      "license_not_supported_by_model",
      `The current model (${model.provider}/${model.model}) can't be sold with the "${input.license}" license under its provider's terms. Available: ${model.licenses.join(", ")}.`,
    );
  }

  // 2. Parallel slots. Queued and running jobs both hold a slot. Counted per
  //    mode so CI traffic on test keys can't block production generations.
  const [{ active }] = await tx
    .select({ active: sql<number>`count(*)::int` })
    .from(generations)
    .where(
      and(
        eq(generations.accountId, key.accountId),
        eq(generations.mode, key.mode),
        inArray(generations.status, ["queued", "running"]),
      ),
    );
  if (active >= plan.parallelLimit) {
    throw Errors.rateLimited(
      "parallel_limit_reached",
      `This account already has ${active} ${key.mode} generation(s) in progress; the ${plan.name} plan allows ${plan.parallelLimit} at once.`,
      PARALLEL_RETRY_AFTER_SEC,
    );
  }

  // 3. Credits (live only; test keys never consume allowance).
  const cost = creditCost(input.license, input.duration_sec);
  const period = periodOf(new Date());
  let charge: { allowance: number; overage: number } | null = { allowance: 0, overage: 0 };
  if (key.mode === "live") {
    const used = await periodConsumption(tx, key.accountId, period);
    charge = splitCharge({
      cost,
      monthlyCredits: plan.monthlyCredits,
      allowanceUsed: used.allowance,
      overageAllowed: plan.overageAllowed,
    });
    if (!charge) {
      const remaining = Math.max(0, plan.monthlyCredits - used.allowance);
      throw Errors.insufficientCredits(
        `This generation costs ${cost} credits but only ${remaining} remain this period, and the ${plan.name} plan does not allow overage.`,
      );
    }
  }

  // 4. Write the job (which is also the queue entry) and the debit together.
  const [gen] = await tx
    .insert(generations)
    .values({
      id: newId("gen"),
      accountId: key.accountId,
      apiKeyId: key.id,
      mode: key.mode,
      prompt: input.prompt,
      durationSec: input.duration_sec,
      license: input.license,
      instrumental: input.instrumental,
      metadata: input.metadata,
      creditsCharged: key.mode === "live" ? cost : 0,
      provider: model.provider,
      model: model.model,
    })
    .returning();

  if (key.mode === "live") {
    await recordDebit(tx, {
      accountId: key.accountId,
      generationId: gen.id,
      apiKeyId: key.id,
      period,
      allowance: charge.allowance,
      overage: charge.overage,
    });
  }
  return gen;
}
