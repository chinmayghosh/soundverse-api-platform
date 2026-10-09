import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { GET as usage } from "@/app/v1/usage/route";
import { changePlan } from "@/server/accounts/service";
import { db } from "@/server/db/client";
import { auditLog, generations } from "@/server/db/schema";
import { call, createTestAccount, createTestKey, genBody, spendCredits } from "../helpers";

const create = (key: string, over = {}) =>
  call(POST, { method: "POST", path: "/v1/generations", key, body: genBody(over) });

// Scenario 12: a Growth account that has used 1,500 credits is downgraded to
// Starter mid-month.
describe("scenario 12: downgrade from Growth to Starter after using 1,500 credits", () => {
  it("applies immediately, does not reset the period, hard-stops new live work, keeps running jobs", async () => {
    const acct = await createTestAccount("growth");
    const key = await createTestKey(acct, "live");
    await spendCredits(acct.accountId, key.id, 1500);

    // On Growth: full_ownership allowed, 4 jobs in flight.
    for (let i = 0; i < 4; i++) expect((await create(key.secret)).status).toBe(202);
    expect((await create(key.secret, { license: "full_ownership" })).status).toBe(202);

    await changePlan({ accountId: acct.accountId, planId: "starter", actorUserId: acct.userId });

    // In-flight jobs are untouched (5 > Starter's limit of 3, still queued).
    const jobs = await db().select().from(generations).where(eq(generations.accountId, acct.accountId));
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(5);

    // Starter's parallel limit applies now.
    const parallel = await create(key.secret);
    expect(parallel.status).toBe(429);
    expect(parallel.body.error.code).toBe("parallel_limit_reached");

    // Free the slots; now the credit rule binds: 200 allowance, 1,500 + 4×1 + 14 = 1,518 used -> 0 left, hard stop.
    await db().update(generations).set({ status: "succeeded" }).where(eq(generations.accountId, acct.accountId));
    const credit = await create(key.secret);
    expect(credit.status).toBe(402);
    expect(credit.body.error.code).toBe("insufficient_credits");

    // Starter doesn't sell full ownership any more.
    const license = await create(key.secret, { license: "full_ownership" });
    expect(license.status).toBe(403);

    const u = await call(usage, { path: "/v1/usage", key: key.secret });
    expect(u.body.plan.id).toBe("starter");
    expect(u.body.credits).toMatchObject({ allowance: 200, used: 1518, remaining: 0, overage: 0 });

    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, "plan.changed"));
    expect(audit).toBeDefined();

    // Test keys keep working: they never consume allowance.
    const testKey = await createTestKey(acct, "test");
    expect((await create(testKey.secret)).status).toBe(202);
  });
});
