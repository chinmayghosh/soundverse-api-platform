import { describe, expect, it } from "vitest";
import { GET as getGeneration } from "@/app/v1/generations/[id]/route";
import { GET as listGenerations } from "@/app/v1/generations/route";
import { call, createTestAccount, createTestKey, insertGeneration } from "../helpers";

// Scenario 8: account B's key requests a job that belongs to account A.
describe("scenario 8: tenant isolation", () => {
  it("returns the same 404 as a nonexistent job, and never lists A's jobs", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const keyA = await createTestKey(a);
    const keyB = await createTestKey(b);
    const job = await insertGeneration(a.accountId, keyA.id);

    const own = await call(getGeneration, { path: `/v1/generations/${job.id}`, key: keyA.secret, params: { id: job.id } });
    expect(own.status).toBe(200);
    expect(own.body.id).toBe(job.id);

    const foreign = await call(getGeneration, { path: `/v1/generations/${job.id}`, key: keyB.secret, params: { id: job.id } });
    const missing = await call(getGeneration, {
      path: "/v1/generations/gen_00000000000000000000000000",
      key: keyB.secret,
      params: { id: "gen_00000000000000000000000000" },
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("resource_not_found");
    // Indistinguishable apart from the request id.
    expect({ ...foreign.body.error, request_id: "" }).toEqual({ ...missing.body.error, request_id: "" });

    const listB = await call(listGenerations, { path: "/v1/generations", key: keyB.secret });
    expect(listB.body.data).toEqual([]);
  });
});
