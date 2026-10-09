import { eq } from "drizzle-orm";
import { ensureAccountForUser } from "@/server/accounts/service";
import { db } from "@/server/db/client";
import { accounts, authUsers, generations, plans } from "@/server/db/schema";
import { newId } from "@/server/ids";
import { SCOPES, createKey } from "@/server/keys/service";
import type { KeyMode } from "@/server/keys/secrets";

// A fresh tenant per test: isolation without truncating (the ledger forbids it).
export async function createTestAccount(planId = "starter") {
  const userId = newId("usr");
  await db()
    .insert(authUsers)
    .values({ id: userId, name: "Test User", email: `${userId.toLowerCase()}@test.local`, emailVerified: true });
  const { accountId } = await ensureAccountForUser({ id: userId, name: "Test Account" });
  await db().update(accounts).set({ planId }).where(eq(accounts.id, accountId));
  return { accountId, userId };
}

export async function createTestKey(
  account: { accountId: string; userId: string },
  mode: KeyMode = "test",
  scopes: string[] = [...SCOPES],
) {
  const { key, secret } = await createKey(
    { accountId: account.accountId, userId: account.userId },
    { name: "test key", mode, scopes },
  );
  return { ...key, secret };
}

// Custom plan rows let tests isolate one limit at a time.
export async function createTestPlan(overrides: Partial<typeof plans.$inferInsert> = {}) {
  const id = newId("plan").toLowerCase();
  await db()
    .insert(plans)
    .values({
      id,
      name: id,
      monthlyCredits: 100,
      parallelLimit: 100,
      reqPerHour: 100_000,
      reqPerDay: 100_000,
      licenses: ["royalty_free", "sync", "full_ownership"],
      overageAllowed: false,
      liveKeysAllowed: true,
      ...overrides,
    });
  return id;
}

export async function insertGeneration(accountId: string, apiKeyId: string) {
  const [row] = await db()
    .insert(generations)
    .values({
      id: newId("gen"),
      accountId,
      apiKeyId,
      mode: "test",
      prompt: "test prompt",
      durationSec: 30,
      license: "royalty_free",
      instrumental: true,
      creditsCharged: 0,
      provider: "mock",
      model: "mock-music-1",
    })
    .returning();
  return row;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each route has its own params type
type RouteHandler = (req: Request, ctx?: any) => Promise<Response>;

// Invoke a Next route handler in-process with a real Request.
export async function call(
  handler: RouteHandler,
  opts: {
    method?: string;
    path: string;
    key?: string;
    body?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, string>;
  },
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://localhost:3000${opts.path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, opts.params ? { params: Promise.resolve(opts.params) } : undefined);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, text };
}

// Simulate credits already spent this period: a finished live job + its debit.
export async function spendCredits(accountId: string, apiKeyId: string, credits: number) {
  const { recordDebit } = await import("@/server/billing/ledger");
  const { periodOf } = await import("@/server/billing/pricing");
  await db().transaction(async (tx) => {
    const [gen] = await tx
      .insert(generations)
      .values({
        id: newId("gen"),
        accountId,
        apiKeyId,
        mode: "live",
        status: "succeeded",
        prompt: "earlier usage",
        durationSec: 60,
        license: "royalty_free",
        instrumental: true,
        creditsCharged: credits,
        provider: "mock",
        model: "mock-music-1",
      })
      .returning();
    await recordDebit(tx, {
      accountId,
      generationId: gen.id,
      apiKeyId,
      period: periodOf(new Date()),
      allowance: credits,
      overage: 0,
    });
  });
}

export const genBody = (over: Record<string, unknown> = {}) => ({
  prompt: "uplifting acoustic pop for a travel vlog, warm guitars",
  duration_sec: 30,
  license: "royalty_free",
  instrumental: true,
  ...over,
});

export function countBy<T>(items: T[], f: (t: T) => string | number) {
  const out: Record<string, number> = {};
  for (const i of items) out[f(i)] = (out[f(i)] ?? 0) + 1;
  return out;
}

/* ---------------- worker helpers ---------------- */

type Step = "ok" | "error" | "timeout" | "reject";

// A provider that follows a script, one step per call: lets tests put a
// failure exactly where they want it ("halfway through" a job).
export function scriptedProvider(steps: Step[], opts: { latencyMs?: number } = {}) {
  const calls: { providerRequestId: string | null }[] = [];
  const provider = {
    name: "scripted",
    async generate(req: import("@/server/providers/types").GenerateRequest) {
      const { ProviderError } = await import("@/server/providers/types");
      const { sleep } = await import("@/server/providers/mock");
      const step = steps[Math.min(calls.length, steps.length - 1)];
      calls.push({ providerRequestId: req.providerRequestId });
      await req.onSubmitted(req.providerRequestId ?? `scripted_${calls.length}`);
      await sleep(opts.latencyMs ?? 5, req.signal);
      if (step === "timeout") await sleep(60_000, req.signal); // hang until our timeout aborts
      if (step === "error") throw new ProviderError("provider_error", "upstream 500");
      if (step === "reject") throw new ProviderError("provider_rejected", "content policy", false);
      return { audio: new Uint8Array([82, 73, 70, 70]), contentType: "audio/wav", format: "wav", durationSec: req.durationSec + 0.84 };
    },
  };
  return { provider, calls };
}

export function testDeps(provider: import("@/server/providers/types").MusicProvider, over: Partial<import("@/server/jobs/worker").WorkerDeps> = {}) {
  return { resolve: () => provider, leaseSec: 30, timeoutMs: 200, maxAttempts: 3, backoffMs: 5, ...over };
}

// Queue state is global; park jobs left by other test files so claimNext only
// sees this test's jobs.
export async function clearQueue() {
  const { inArray } = await import("drizzle-orm");
  await db().update(generations).set({ status: "canceled" }).where(inArray(generations.status, ["queued", "running"]));
}
