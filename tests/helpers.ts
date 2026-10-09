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
