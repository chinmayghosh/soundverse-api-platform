import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { GET as getOne } from "@/app/v1/generations/[id]/route";
import { db } from "@/server/db/client";
import { ledgerEntries, webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import { newId } from "@/server/ids";
import { claimNext, processJob } from "@/server/jobs/worker";
import { call, clearQueue, createTestAccount, createTestKey, genBody, scriptedProvider, testDeps } from "../helpers";

async function setup() {
  const acct = await createTestAccount("starter");
  const key = await createTestKey(acct, "live");
  await db().insert(webhookEndpoints).values({
    id: newId("we"),
    accountId: acct.accountId,
    url: "https://example.com/hook",
    secretCiphertext: "unused-in-this-test",
  });
  const created = await call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() });
  expect(created.status).toBe(202);
  return { acct, key, id: created.body.id as string };
}

const netCredits = async (accountId: string) =>
  (
    await db()
      .select({ n: sql<number>`coalesce(sum(${ledgerEntries.allowanceCredits} + ${ledgerEntries.overageCredits}),0)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, accountId))
  )[0].n;

// Scenario 7: the music model times out or returns an error halfway through a job.
describe("scenario 7: provider timeout / error mid-job", () => {
  beforeEach(clearQueue);

  it.each([
    ["timeout", "provider_timeout"],
    ["error", "provider_error"],
  ] as const)("retries, then fails with %s -> %s, refunds, and emits generation.failed", async (step, code) => {
    const { acct, key, id } = await setup();
    expect(await netCredits(acct.accountId)).toBe(1);

    const { provider, calls } = scriptedProvider([step, step, step]);
    const job = await claimNext(30);
    expect(job!.id).toBe(id);
    expect(await processJob(job!, testDeps(provider))).toBe("failed");
    expect(calls).toHaveLength(3); // maxAttempts

    const res = await call(getOne, { path: `/v1/generations/${id}`, key: key.secret, params: { id } });
    expect(res.body).toMatchObject({ status: "failed", output: null, error: { code } });
    // The model never silently changed.
    expect(res.body.model).toBe("mock/mock-music-1");

    expect(await netCredits(acct.accountId)).toBe(0);
    const ledger = await db().select().from(ledgerEntries).where(eq(ledgerEntries.generationId, id));
    expect(ledger.map((l) => l.kind).sort()).toEqual(["debit", "refund"]);

    const events = await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.accountId, acct.accountId));
    expect(events.map((e) => e.eventType)).toEqual(["generation.failed"]);
  });

  it("recovers when a retry succeeds: one charge, no refund", async () => {
    const { acct, key, id } = await setup();
    const { provider, calls } = scriptedProvider(["error", "ok"]);
    const job = await claimNext(30);
    expect(await processJob(job!, testDeps(provider))).toBe("succeeded");
    expect(calls).toHaveLength(2);
    // The failed provider request is not resumed; the retry submits fresh.
    expect(calls[1].providerRequestId).toBeNull();

    const res = await call(getOne, { path: `/v1/generations/${id}`, key: key.secret, params: { id } });
    expect(res.body.status).toBe("succeeded");
    expect(await netCredits(acct.accountId)).toBe(1);
  });

  it("resumes the same provider request after a timeout instead of paying twice", async () => {
    await setup();
    const { provider, calls } = scriptedProvider(["timeout", "ok"]);
    const job = await claimNext(30);
    expect(await processJob(job!, testDeps(provider))).toBe("succeeded");
    expect(calls[1].providerRequestId).toBe("scripted_1");
  });

  it("does not retry a non-retryable rejection", async () => {
    const { id } = await setup();
    const { provider, calls } = scriptedProvider(["reject"]);
    const job = await claimNext(30);
    expect(await processJob(job!, testDeps(provider))).toBe("failed");
    expect(calls).toHaveLength(1);
    const [row] = await db().select().from(ledgerEntries).where(and(eq(ledgerEntries.generationId, id), eq(ledgerEntries.kind, "refund")));
    expect(row).toBeDefined();
  });
});
