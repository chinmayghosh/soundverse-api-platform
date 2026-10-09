import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { ledgerEntries } from "../db/schema";
import { newId } from "../ids";

// Balances are never stored; they are always Σ over immutable ledger rows.
// Debits are positive, refunds negative, so a sum is the net consumption.
export async function periodConsumption(tx: Tx | Db, accountId: string, period: string) {
  const [row] = await tx
    .select({
      allowance: sql<number>`coalesce(sum(${ledgerEntries.allowanceCredits}), 0)::int`,
      overage: sql<number>`coalesce(sum(${ledgerEntries.overageCredits}), 0)::int`,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountId, accountId), eq(ledgerEntries.period, period)));
  return row;
}

// Split a charge between what's left of the monthly allowance and overage.
// Returns null when it doesn't fit and overage isn't allowed (hard stop).
export function splitCharge(opts: {
  cost: number;
  monthlyCredits: number;
  allowanceUsed: number;
  overageAllowed: boolean;
}): { allowance: number; overage: number } | null {
  // max(0, …): after a downgrade, usage can exceed the new allowance.
  const remaining = Math.max(0, opts.monthlyCredits - opts.allowanceUsed);
  if (opts.cost <= remaining) return { allowance: opts.cost, overage: 0 };
  if (!opts.overageAllowed) return null;
  return { allowance: remaining, overage: opts.cost - remaining };
}

export async function recordDebit(
  tx: Tx,
  e: { accountId: string; generationId: string; apiKeyId: string; period: string; allowance: number; overage: number },
) {
  await tx.insert(ledgerEntries).values({
    id: newId("led"),
    accountId: e.accountId,
    generationId: e.generationId,
    apiKeyId: e.apiKeyId,
    period: e.period,
    kind: "debit",
    allowanceCredits: e.allowance,
    overageCredits: e.overage,
  });
}

// Reverses a generation's debit exactly (same period and split), so a refund
// in November for an October job restores October's allowance. The unique
// (generation_id, kind) index makes a double refund impossible.
export async function refundGeneration(tx: Tx, generationId: string): Promise<boolean> {
  const [debit] = await tx
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.generationId, generationId), eq(ledgerEntries.kind, "debit")));
  if (!debit) return false; // test-mode jobs are never debited
  const inserted = await tx
    .insert(ledgerEntries)
    .values({
      id: newId("led"),
      accountId: debit.accountId,
      generationId,
      apiKeyId: debit.apiKeyId,
      period: debit.period,
      kind: "refund",
      allowanceCredits: -debit.allowanceCredits,
      overageCredits: -debit.overageCredits,
    })
    .onConflictDoNothing()
    .returning({ id: ledgerEntries.id });
  return inserted.length > 0;
}
