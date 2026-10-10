import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { providerUsage } from "@/server/db/schema";
import { env } from "@/server/env";
import { reserveProviderCall } from "@/server/providers/budget";
import { FAL_MODEL_ID, FalProvider } from "@/server/providers/fal";
import { ProviderError, type GenerateRequest } from "@/server/providers/types";
import { call, createTestAccount, createTestKey, genBody } from "../helpers";

// A scripted stand-in for fal's queue API. No network, no key, no spend.
function fakeFal(script: { submit?: number; statuses?: string[]; result?: unknown; audioBytes?: number }) {
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
  let polls = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({
      method,
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string> | undefined)?.Authorization,
    });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (method === "POST") {
      return script.submit && script.submit !== 200
        ? new Response("content policy violation", { status: script.submit })
        : json(200, { request_id: "fal-req-1" });
    }
    if (url.endsWith("/status")) {
      const s = script.statuses ?? ["COMPLETED"];
      return json(200, { status: s[Math.min(polls++, s.length - 1)] });
    }
    if (url.includes("/requests/")) return json(200, script.result ?? { audio: { url: "https://cdn.fal.media/x.mp3" } });
    return new Response(new Uint8Array(script.audioBytes ?? 32_000 * 30), { status: 200 }); // 30s at 256 kbps
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  jobId: "gen_x",
  model: "minimax-music-v2.6",
  prompt: "warm acoustic pop",
  durationSec: 30,
  instrumental: true,
  signal: new AbortController().signal,
  providerRequestId: null,
  onSubmitted: async () => {},
  ...over,
});

describe("FalProvider (MiniMax Music v2.6 via fal queue API)", () => {
  it("submits, polls until COMPLETED, downloads the mp3", async () => {
    const { fetchImpl, calls } = fakeFal({ statuses: ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"] });
    const submitted: string[] = [];
    const p = new FalProvider({ apiKey: "k", fetch: fetchImpl, pollMs: 1 });
    const out = await p.generate(req({ onSubmitted: async (id) => void submitted.push(id) }));

    expect(out).toMatchObject({ format: "mp3", contentType: "audio/mpeg", durationSec: 30 });
    expect(submitted).toEqual(["fal-req-1"]);
    expect(calls[0]).toMatchObject({ method: "POST", url: `https://queue.fal.run/${FAL_MODEL_ID}`, auth: "Key k" });
    expect(calls[0].body).toMatchObject({ is_instrumental: true, audio_setting: { format: "mp3", sample_rate: 44100, bitrate: 256000 } });
    expect((calls[0].body as { prompt: string }).prompt).toContain("about 30 seconds");
    expect(calls.filter((c) => c.url.endsWith("/status"))).toHaveLength(3);
    expect(calls[1].url).toBe("https://queue.fal.run/fal-ai/minimax-music/requests/fal-req-1/status");
  });

  it("resumes an already-submitted request without paying again", async () => {
    const { fetchImpl, calls } = fakeFal({});
    let reserved = 0;
    const p = new FalProvider({ apiKey: "k", fetch: fetchImpl, pollMs: 1, reserveCall: async () => (reserved++, true) });
    await p.generate(req({ providerRequestId: "fal-req-earlier" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(reserved).toBe(0);
    expect(calls[0].url).toContain("/requests/fal-req-earlier/status");
  });

  it("maps a 4xx refusal to a non-retryable rejection, 5xx to a retryable error", async () => {
    const refused = new FalProvider({ apiKey: "k", fetch: fakeFal({ submit: 422 }).fetchImpl });
    const err = await refused.generate(req()).catch((e) => e);
    expect(err).toMatchObject({ code: "provider_rejected", retryable: false });
    expect(err.message).not.toContain("content policy violation"); // provider detail stays in our logs
    const down = new FalProvider({ apiKey: "k", fetch: fakeFal({ submit: 503 }).fetchImpl });
    await expect(down.generate(req())).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("refuses to submit when the spend cap is exhausted", async () => {
    const { fetchImpl, calls } = fakeFal({});
    const p = new FalProvider({ apiKey: "k", fetch: fetchImpl, reserveCall: async () => false });
    await expect(p.generate(req())).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });
});

describe("provider spend cap", () => {
  it("never grants more calls than the cap, even concurrently", async () => {
    const name = `capped-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveProviderCall(name, 7)));
    expect(results.filter(Boolean)).toHaveLength(7);
    const [row] = await db().select().from(providerUsage).where(eq(providerUsage.provider, name));
    expect(row.calls).toBe(7);
  });
});

describe("licenses the live model can back", () => {
  const original = env().LIVE_PROVIDER;
  afterEach(() => {
    env().LIVE_PROVIDER = original;
  });

  it("refuses full_ownership on the real model even on Growth, but test keys (mock) allow it", async () => {
    env().LIVE_PROVIDER = "fal";
    const acct = await createTestAccount("growth");
    const live = await createTestKey(acct, "live");
    const test = await createTestKey(acct, "test");
    const body = genBody({ license: "full_ownership" });

    const r = await call(POST, { method: "POST", path: "/v1/generations", key: live.secret, body });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("license_not_supported_by_model");

    const sync = await call(POST, { method: "POST", path: "/v1/generations", key: live.secret, body: genBody({ license: "sync" }) });
    expect(sync.status).toBe(202);
    expect(sync.body.model).toBe("fal/minimax-music-v2.6");

    const t = await call(POST, { method: "POST", path: "/v1/generations", key: test.secret, body });
    expect(t.status).toBe(202);
    expect(t.body.model).toBe("mock/mock-music-1");
  });
});
