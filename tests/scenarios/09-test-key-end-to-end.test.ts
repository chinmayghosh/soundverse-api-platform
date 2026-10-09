import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { GET as getOne } from "@/app/v1/generations/[id]/route";
import { GET as usage } from "@/app/v1/usage/route";
import { claimNext, processJob } from "@/server/jobs/worker";
import { MockProvider } from "@/server/providers/mock";
import { call, clearQueue, createTestAccount, createTestKey, genBody, testDeps } from "../helpers";

// Scenario 9: a developer runs the whole quickstart with a test key.
// (scripts/quickstart.sh runs the same flow over HTTP against a live stack.)
describe("scenario 9: quickstart with a test key", () => {
  beforeEach(clearQueue);

  it("works end to end on a fresh Sandbox account, returns playable audio, costs nothing", async () => {
    const acct = await createTestAccount("sandbox");
    const key = await createTestKey(acct, "test");

    const created = await call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ status: "queued", mode: "test", credits_charged: 0, model: "mock/mock-music-1" });

    const job = await claimNext(30);
    expect(await processJob(job!, testDeps(new MockProvider({ latencyMs: 20, failureRate: 0 })))).toBe("succeeded");

    const done = await call(getOne, { path: `/v1/generations/${job!.id}`, key: key.secret, params: { id: job!.id } });
    expect(done.body.status).toBe("succeeded");
    expect(done.body.output).toMatchObject({ format: "wav", duration_sec: 30 });

    // The signed URL really serves the file...
    const audio = await fetch(done.body.output.audio_url);
    expect(audio.status).toBe(200);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe("RIFF");
    expect(bytes.length).toBe(44 + 8000 * 30);

    // ...and only with a valid signature.
    const tampered = done.body.output.audio_url.replace(/X-Amz-Signature=[0-9a-f]+/, "X-Amz-Signature=" + "0".repeat(64));
    expect((await fetch(tampered)).status).toBe(403);
    const unsigned = done.body.output.audio_url.split("?")[0];
    expect((await fetch(unsigned)).status).toBe(403);

    const u = await call(usage, { path: "/v1/usage", key: key.secret });
    expect(u.body.credits).toMatchObject({ used: 0, overage: 0 });
  });
});
