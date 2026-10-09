import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { generations, ledgerEntries } from "@/server/db/schema";
import { call, countBy, createTestAccount, createTestKey, genBody } from "../helpers";

// Scenario 4: a Starter account fires 20 generation requests at the same instant.
describe("scenario 4: 20 simultaneous creates on Starter (parallel limit 3)", () => {
  it("accepts exactly 3, rejects 17 with 429 parallel_limit_reached, charges exactly 3", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() })),
    );

    expect(countBy(results, (r) => r.status)).toEqual({ 202: 3, 429: 17 });
    for (const r of results.filter((r) => r.status === 429)) {
      expect(r.body.error).toMatchObject({ type: "rate_limit_error", code: "parallel_limit_reached" });
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(r.headers.get("x-ratelimit-remaining")).not.toBeNull();
    }
    const accepted = results.filter((r) => r.status === 202);
    expect(accepted.every((r) => r.body.status === "queued" && r.body.credits_charged === 1)).toBe(true);

    const jobs = await db().select().from(generations).where(eq(generations.accountId, acct.accountId));
    const ledger = await db().select().from(ledgerEntries).where(eq(ledgerEntries.accountId, acct.accountId));
    expect(jobs).toHaveLength(3);
    expect(ledger).toHaveLength(3);
    expect(ledger.reduce((s, l) => s + l.allowanceCredits, 0)).toBe(3);
  });

  it("test-key and live-key slots are counted separately", async () => {
    const acct = await createTestAccount("starter");
    const live = await createTestKey(acct, "live");
    const test = await createTestKey(acct, "test");
    const fire = (k: string) =>
      Promise.all(Array.from({ length: 5 }, () => call(POST, { method: "POST", path: "/v1/generations", key: k, body: genBody() })));
    const [l, t] = await Promise.all([fire(live.secret), fire(test.secret)]);
    expect(countBy(l, (r) => r.status)).toEqual({ 202: 3, 429: 2 });
    expect(countBy(t, (r) => r.status)).toEqual({ 202: 3, 429: 2 });
    // Test jobs are free.
    expect(t.filter((r) => r.status === 202).every((r) => r.body.credits_charged === 0)).toBe(true);
  });
});
