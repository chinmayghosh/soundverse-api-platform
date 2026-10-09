import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { generations, ledgerEntries } from "@/server/db/schema";
import { call, createTestAccount, createTestKey, genBody } from "../helpers";

// Scenario 13: a Starter account requests a full_ownership license.
describe("scenario 13: license outside the plan", () => {
  it.each(["live", "test"] as const)("rejects with 403 license_not_in_plan and charges nothing (%s key)", async (mode) => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, mode);
    const res = await call(POST, {
      method: "POST",
      path: "/v1/generations",
      key: key.secret,
      body: genBody({ license: "full_ownership" }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ type: "permission_error", code: "license_not_in_plan" });
    expect(res.body.error.message).toContain("royalty_free, sync");
    expect(await db().select().from(generations).where(eq(generations.accountId, acct.accountId))).toEqual([]);
    expect(await db().select().from(ledgerEntries).where(eq(ledgerEntries.accountId, acct.accountId))).toEqual([]);
  });

  it("accepts sync on Starter at 6 credits per started minute", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");
    const res = await call(POST, {
      method: "POST",
      path: "/v1/generations",
      key: key.secret,
      body: genBody({ license: "sync", duration_sec: 90 }),
    });
    expect(res.status).toBe(202);
    expect(res.body.credits_charged).toBe(12);
  });
});
