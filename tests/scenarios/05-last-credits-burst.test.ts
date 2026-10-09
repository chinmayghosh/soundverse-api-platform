import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { GET as usage } from "@/app/v1/usage/route";
import { db } from "@/server/db/client";
import { ledgerEntries } from "@/server/db/schema";
import { call, countBy, createTestAccount, createTestKey, createTestPlan, genBody, spendCredits } from "../helpers";

const fire = (key: string, n: number) =>
  Promise.all(
    Array.from({ length: n }, () =>
      call(POST, { method: "POST", path: "/v1/generations", key, body: genBody({ license: "royalty_free" }) }),
    ),
  );

async function allowanceUsed(accountId: string) {
  const [r] = await db()
    .select({ s: sql<number>`coalesce(sum(${ledgerEntries.allowanceCredits}),0)::int`, o: sql<number>`coalesce(sum(${ledgerEntries.overageCredits}),0)::int` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountId, accountId)));
  return r;
}

// Scenario 5: a Starter account with 5 credits left fires 10 royalty_free
// requests at the same instant.
describe("scenario 5: 10 simultaneous requests with 5 credits left", () => {
  it("on Starter, the parallel limit (3) binds first: 3 accepted, 7 rejected, 2 credits left", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    await spendCredits(acct.accountId, key.id, 195);

    const results = await fire(key.secret, 10);
    expect(countBy(results, (r) => r.status)).toEqual({ 202: 3, 429: 7 });
    expect((await allowanceUsed(acct.accountId)).s).toBe(198);

    const u = await call(usage, { path: "/v1/usage", key: key.secret });
    expect(u.body.credits).toMatchObject({ allowance: 200, used: 198, remaining: 2, overage: 0 });
  });

  it("with the parallel limit out of the way, exactly 5 are accepted and 5 get 402", async () => {
    // Starter's credit rules, but parallel 20, to isolate the credit check.
    const planId = await createTestPlan({ monthlyCredits: 200, parallelLimit: 20, overageAllowed: false });
    const acct = await createTestAccount(planId);
    const key = await createTestKey(acct, "live");
    await spendCredits(acct.accountId, key.id, 195);

    const results = await fire(key.secret, 10);
    expect(countBy(results, (r) => r.status)).toEqual({ 202: 5, 402: 5 });
    for (const r of results.filter((r) => r.status === 402)) {
      expect(r.body.error).toMatchObject({ type: "billing_error", code: "insufficient_credits" });
    }
    // Never a single credit over the allowance.
    expect(await allowanceUsed(acct.accountId)).toEqual({ s: 200, o: 0 });
  });

  it("on an overage plan, all 10 are accepted: 5 from allowance, 5 billed as overage", async () => {
    const planId = await createTestPlan({ monthlyCredits: 200, parallelLimit: 20, overageAllowed: true });
    const acct = await createTestAccount(planId);
    const key = await createTestKey(acct, "live");
    await spendCredits(acct.accountId, key.id, 195);

    const results = await fire(key.secret, 10);
    expect(countBy(results, (r) => r.status)).toEqual({ 202: 10 });
    expect(await allowanceUsed(acct.accountId)).toEqual({ s: 200, o: 5 });
  });
});
