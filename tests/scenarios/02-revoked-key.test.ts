import { describe, expect, it } from "vitest";
import { GET as listGenerations } from "@/app/v1/generations/route";
import { revokeKey } from "@/server/keys/service";
import { call, createTestAccount, createTestKey } from "../helpers";

// Scenario 2: a revoked key fails on its very next request.
describe("scenario 2: revocation is immediate", () => {
  it("rejects the request right after revoke with 401 api_key_revoked", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);

    const before = await call(listGenerations, { path: "/v1/generations", key: key.secret });
    expect(before.status).toBe(200);

    await revokeKey({ accountId: acct.accountId, userId: acct.userId }, key.id);

    const after = await call(listGenerations, { path: "/v1/generations", key: key.secret });
    expect(after.status).toBe(401);
    expect(after.body.error).toMatchObject({ type: "authentication_error", code: "api_key_revoked" });
    expect(after.body.error.request_id).toMatch(/^req_/);
    expect(after.headers.get("x-request-id")).toBe(after.body.error.request_id);
  });

  it("cannot revoke another account's key", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const keyA = await createTestKey(a);
    await expect(revokeKey({ accountId: b.accountId, userId: b.userId }, keyA.id)).rejects.toMatchObject({
      status: 404,
    });
    const res = await call(listGenerations, { path: "/v1/generations", key: keyA.secret });
    expect(res.status).toBe(200);
  });
});
