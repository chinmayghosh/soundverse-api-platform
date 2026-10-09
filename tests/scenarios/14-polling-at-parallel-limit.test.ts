import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as getGeneration } from "@/app/v1/generations/[id]/route";
import { POST } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { generations, ledgerEntries } from "@/server/db/schema";
import { call, countBy, createTestAccount, createTestKey, createTestPlan, genBody } from "../helpers";

// Scenario 14: a client polls a running job every second while generating at
// its plan's parallel limit.
describe("scenario 14: polling at the parallel limit", () => {
  it("polls never take slots or credits; they count toward the request rate limit", async () => {
    // Starter-like, but a small hourly limit so the test runs fast.
    const planId = await createTestPlan({ parallelLimit: 3, reqPerHour: 20, monthlyCredits: 200 });
    const acct = await createTestAccount(planId);
    const key = await createTestKey(acct, "live");

    const created = [];
    for (let i = 0; i < 3; i++) {
      created.push(await call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() }));
    }
    expect(created.map((r) => r.status)).toEqual([202, 202, 202]);
    await db().update(generations).set({ status: "running" }).where(eq(generations.accountId, acct.accountId));
    const jobId = created[0].body.id;

    // 3 requests used; 17 left this hour. Poll 25 times.
    const polls = [];
    for (let i = 0; i < 25; i++) {
      polls.push(await call(getGeneration, { path: `/v1/generations/${jobId}`, key: key.secret, params: { id: jobId } }));
    }
    expect(countBy(polls, (p) => p.status)).toEqual({ 200: 17, 429: 8 });
    expect(polls[0].body.status).toBe("running");
    expect(polls[16].headers.get("x-ratelimit-remaining")).toBe("0");

    const limited = polls[17];
    expect(limited.body.error).toMatchObject({ type: "rate_limit_error", code: "hourly_rate_limit_exceeded" });
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(limited.headers.get("x-ratelimit-limit")).toBe("20");

    // Nothing about the jobs or billing changed.
    const jobs = await db().select().from(generations).where(eq(generations.accountId, acct.accountId));
    expect(jobs.map((j) => j.status)).toEqual(["running", "running", "running"]);
    const ledger = await db().select().from(ledgerEntries).where(eq(ledgerEntries.accountId, acct.accountId));
    expect(ledger).toHaveLength(3);
  });
});
