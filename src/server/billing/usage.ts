import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, apiKeys, generations, ledgerEntries, plans } from "../db/schema";
import { Errors } from "../errors";
import { periodBounds, periodOf } from "./pricing";
import { periodConsumption } from "./ledger";

// Everything here is derived from the append-only ledger, which is what makes
// it reconcilable: Σ by_key == Σ by_day == used (+ overage).
export async function getUsage(accountId: string, period = periodOf(new Date())) {
  const [row] = await db()
    .select({ plan: plans })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .where(eq(accounts.id, accountId));
  if (!row) throw Errors.notFound("account");
  const { plan } = row;

  const consumed = await periodConsumption(db(), accountId, period);
  const { start, end } = periodBounds(period);

  const byKey = await db()
    .select({
      apiKeyId: ledgerEntries.apiKeyId,
      prefix: apiKeys.prefix,
      name: apiKeys.name,
      credits: sql<number>`sum(${ledgerEntries.allowanceCredits} + ${ledgerEntries.overageCredits})::int`,
    })
    .from(ledgerEntries)
    .innerJoin(apiKeys, eq(apiKeys.id, ledgerEntries.apiKeyId))
    .where(and(eq(ledgerEntries.accountId, accountId), eq(ledgerEntries.period, period)))
    .groupBy(ledgerEntries.apiKeyId, apiKeys.prefix, apiKeys.name)
    .orderBy(apiKeys.prefix);

  // Days are bucketed by when the ledger row was written (UTC).
  const byDay = await db()
    .select({
      day: sql<string>`to_char(${ledgerEntries.createdAt} at time zone 'utc', 'YYYY-MM-DD')`,
      credits: sql<number>`sum(${ledgerEntries.allowanceCredits} + ${ledgerEntries.overageCredits})::int`,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountId, accountId), eq(ledgerEntries.period, period)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const active = await db()
    .select({ mode: generations.mode, n: sql<number>`count(*)::int` })
    .from(generations)
    .where(and(eq(generations.accountId, accountId), inArray(generations.status, ["queued", "running"])))
    .groupBy(generations.mode);
  const activeOf = (m: "test" | "live") => active.find((a) => a.mode === m)?.n ?? 0;

  return {
    object: "usage",
    period,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    plan: {
      id: plan.id,
      name: plan.name,
      monthly_credits: plan.monthlyCredits,
      parallel_limit: plan.parallelLimit,
      requests_per_hour: plan.reqPerHour,
      requests_per_day: plan.reqPerDay,
      licenses: plan.licenses,
      overage_allowed: plan.overageAllowed,
    },
    credits: {
      allowance: plan.monthlyCredits,
      used: consumed.allowance,
      // After a downgrade, used can exceed the allowance; remaining floors at 0.
      remaining: Math.max(0, plan.monthlyCredits - consumed.allowance),
      overage: consumed.overage,
    },
    parallel: { limit: plan.parallelLimit, live_in_progress: activeOf("live"), test_in_progress: activeOf("test") },
    by_key: byKey.map((k) => ({ api_key_id: k.apiKeyId, prefix: k.prefix, name: k.name, credits: k.credits })),
    by_day: byDay,
  };
}
