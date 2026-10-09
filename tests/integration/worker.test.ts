import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as cancel } from "@/app/v1/generations/[id]/cancel/route";
import { POST } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { generations, ledgerEntries } from "@/server/db/schema";
import { MAX_CLAIMS, claimNext, processJob, reapExpiredLeases } from "@/server/jobs/worker";
import {
  call,
  clearQueue,
  createTestAccount,
  createTestKey,
  createTestPlan,
  genBody,
  scriptedProvider,
  testDeps,
} from "../helpers";

const create = async (key: string) => {
  const r = await call(POST, { method: "POST", path: "/v1/generations", key, body: genBody() });
  expect(r.status).toBe(202);
  return r.body.id as string;
};
const cancelReq = (key: string, id: string) =>
  call(cancel, { method: "POST", path: `/v1/generations/${id}/cancel`, key, params: { id } });
const statusOf = async (id: string) => (await db().select().from(generations).where(eq(generations.id, id)))[0];
const expireLease = (id: string) =>
  db().update(generations).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(generations.id, id));
const ledgerKinds = async (id: string) =>
  (await db().select().from(ledgerEntries).where(eq(ledgerEntries.generationId, id))).map((l) => l.kind).sort();

describe("queue claiming", () => {
  beforeEach(clearQueue);

  it("hands each job to exactly one of many concurrent workers", async () => {
    const planId = await createTestPlan({ parallelLimit: 20 });
    const acct = await createTestAccount(planId);
    const key = await createTestKey(acct, "test");
    const ids = await Promise.all(Array.from({ length: 12 }, () => create(key.secret)));

    const claimed = (await Promise.all(Array.from({ length: 30 }, () => claimNext(30)))).filter(Boolean);
    expect(claimed).toHaveLength(12);
    expect(new Set(claimed.map((j) => j!.id))).toEqual(new Set(ids));
  });
});

describe("worker restart", () => {
  beforeEach(clearQueue);

  it("requeues a job whose worker died, and a second worker completes it", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const id = await create(key.secret);

    const dead = await claimNext(30); // worker A claims, then "crashes"
    expect(dead!.attempts).toBe(1);
    await expireLease(id);
    expect(await reapExpiredLeases()).toMatchObject({ requeued: 1 });
    expect((await statusOf(id)).status).toBe("queued");

    const job = await claimNext(30); // worker B
    expect(job!.attempts).toBe(2);
    expect(await processJob(job!, testDeps(scriptedProvider(["ok"]).provider))).toBe("succeeded");
    expect(await ledgerKinds(id)).toEqual(["debit"]);
  });

  it("fences out a zombie worker: a stale claim can't overwrite the new one", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const id = await create(key.secret);

    const zombie = await claimNext(30);
    await expireLease(id);
    await reapExpiredLeases();
    const fresh = await claimNext(30);

    // The fresh claim fails; the zombie (claim #1) then tries to report success.
    expect(await processJob(fresh!, testDeps(scriptedProvider(["reject"]).provider))).toBe("failed");
    expect(await processJob(zombie!, testDeps(scriptedProvider(["ok"]).provider))).toBe("abandoned");
    expect((await statusOf(id)).status).toBe("failed");
    expect(await ledgerKinds(id)).toEqual(["debit", "refund"]);
  });

  it(`fails and refunds a job interrupted ${MAX_CLAIMS} times`, async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const id = await create(key.secret);
    for (let i = 0; i < MAX_CLAIMS; i++) {
      await claimNext(30);
      await expireLease(id);
      await reapExpiredLeases();
    }
    const job = await statusOf(id);
    expect(job).toMatchObject({ status: "failed", errorCode: "worker_lost" });
    expect(await ledgerKinds(id)).toEqual(["debit", "refund"]);
  });
});

describe("cancel", () => {
  beforeEach(clearQueue);

  it("cancels a queued job with a full refund; repeating it is a no-op", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const id = await create(key.secret);

    const r = await cancelReq(key.secret, id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("canceled");
    expect(await ledgerKinds(id)).toEqual(["debit", "refund"]);

    const again = await cancelReq(key.secret, id);
    expect(again.status).toBe(200);
    expect(await ledgerKinds(id)).toEqual(["debit", "refund"]);
    expect(await claimNext(30)).toBeNull(); // never reaches a worker
  });

  it("cancels a running job without refund; the worker stops and can't overwrite it", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const id = await create(key.secret);

    const job = await claimNext(30);
    const { provider } = scriptedProvider(["ok"], { latencyMs: 1500 });
    // Short lease so the heartbeat (every leaseSec/3, min 1s) notices quickly.
    const running = processJob(job!, testDeps(provider, { leaseSec: 3, timeoutMs: 10_000 }));
    await new Promise((r) => setTimeout(r, 100));
    expect((await cancelReq(key.secret, id)).body.status).toBe("canceled");

    expect(await running).toBe("abandoned");
    expect((await statusOf(id)).status).toBe("canceled");
    expect(await ledgerKinds(id)).toEqual(["debit"]);
  });

  it("refuses to cancel a finished job, and hides other tenants' jobs", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const id = await create(key.secret);
    const job = await claimNext(30);
    await processJob(job!, testDeps(scriptedProvider(["ok"]).provider));

    const r = await cancelReq(key.secret, id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("generation_not_cancelable");

    const other = await createTestKey(await createTestAccount("starter"), "live");
    expect((await cancelReq(other.secret, id)).status).toBe(404);
  });

  it("cancel racing a claim: exactly one wins", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const id = await create(key.secret);
    const [c, claimed] = await Promise.all([cancelReq(key.secret, id), claimNext(30)]);
    const final = await statusOf(id);
    if (claimed) {
      // Claimed first: the cancel hit a running job (no refund).
      expect(final.status).toBe("canceled");
      expect(await ledgerKinds(id)).toEqual(["debit"]);
    } else {
      expect(c.body.status).toBe("canceled");
      expect(await ledgerKinds(id)).toEqual(["debit", "refund"]);
    }
  });
});
