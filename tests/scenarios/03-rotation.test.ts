import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as listGenerations } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { apiKeys, auditLog } from "@/server/db/schema";
import { rotateKey } from "@/server/keys/service";
import { call, createTestAccount, createTestKey } from "../helpers";

const list = (key: string) => call(listGenerations, { path: "/v1/generations", key });

// Scenario 3: a customer rotates their key without any failed requests.
describe("scenario 3: zero-downtime rotation", () => {
  it("keeps old and new keys valid during the grace window, then retires the old one", async () => {
    const acct = await createTestAccount();
    const old = await createTestKey(acct);

    // Integration traffic keeps flowing on the old key while it rotates.
    const traffic = Array.from({ length: 10 }, () => list(old.secret));
    const rotated = await rotateKey({ accountId: acct.accountId, userId: acct.userId }, old.id, 3600);
    const during = await Promise.all(traffic);
    expect(during.every((r) => r.status === 200)).toBe(true);

    // Both work after rotation, so the customer can deploy the new secret at leisure.
    expect((await list(old.secret)).status).toBe(200);
    expect((await list(rotated.secret)).status).toBe(200);
    expect(rotated.key.scopes).toEqual(old.scopes);
    expect(rotated.key.mode).toBe(old.mode);

    // Simulate the grace window ending.
    await db().update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, old.id));
    const expired = await list(old.secret);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("api_key_expired");
    expect((await list(rotated.secret)).status).toBe(200);

    const audit = await db().select().from(auditLog).where(eq(auditLog.targetId, old.id));
    expect(audit.map((a) => a.action).sort()).toEqual(["key.created", "key.rotated"]);
  });

  it("refuses to rotate the same key twice (only one successor)", async () => {
    const acct = await createTestAccount();
    const old = await createTestKey(acct);
    const actor = { accountId: acct.accountId, userId: acct.userId };
    const results = await Promise.allSettled([rotateKey(actor, old.id), rotateKey(actor, old.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "key_already_rotated" },
    });
  });

  it("grace 0 cuts over immediately", async () => {
    const acct = await createTestAccount();
    const old = await createTestKey(acct);
    const rotated = await rotateKey({ accountId: acct.accountId, userId: acct.userId }, old.id, 0);
    expect((await list(old.secret)).status).toBe(401);
    expect((await list(rotated.secret)).status).toBe(200);
  });
});
