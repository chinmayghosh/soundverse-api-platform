import { toNextJsHandler } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { GET as listGenerations } from "@/app/v1/generations/route";
import { getAuth } from "@/server/auth/auth";
import { db } from "@/server/db/client";
import { accounts, authUsers, memberships } from "@/server/db/schema";
import { createKey } from "@/server/keys/service";
import { ensureAccountForUser } from "@/server/accounts/service";
import { call, createTestAccount, createTestKey } from "../helpers";

const auth = () => toNextJsHandler(getAuth());
const post = (path: string, body: unknown) =>
  auth().POST(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    }),
  );

describe("dashboard accounts (Better Auth)", () => {
  it("sign-up blocks login until the logged link is used; the first dashboard load creates a Sandbox tenant", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const email = `dev${Date.now()}@example.com`;
    const signUp = await post("/sign-up/email", { name: "Dev", email, password: "correct horse battery" });
    expect(signUp.status).toBe(200);

    const blocked = await post("/sign-in/email", { email, password: "correct horse battery" });
    expect(blocked.status).toBe(403);

    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`[email] verify ${email}`));
    const url = line!.match(/https?:\/\/\S+/)![0];
    log.mockRestore();
    const verified = await auth().GET(new Request(url));
    expect([200, 302]).toContain(verified.status);

    const ok = await post("/sign-in/email", { email, password: "correct horse battery" });
    expect(ok.status).toBe(200);

    // What requireDashboard() does with the verified session user:
    const [user] = await db().select().from(authUsers).where(eq(authUsers.email, email));
    expect(user.emailVerified).toBe(true);
    await ensureAccountForUser(user);
    const [member] = await db().select().from(memberships).where(eq(memberships.userId, user.id));
    const [acct] = await db().select().from(accounts).where(eq(accounts.id, member.accountId));
    expect(member.role).toBe("owner");
    expect(acct.planId).toBe("sandbox");
  });
});

describe("sign-up with an email that already has an account", () => {
  it("looks successful (no account enumeration) but creates nothing and can't take over the account", async () => {
    const email = `taken${Date.now()}@example.com`;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await post("/sign-up/email", { name: "Owner", email, password: "owner-pass-1" })).status).toBe(200);
    const url = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`[email] verify ${email}`))!.match(/https?:\/\/\S+/)![0];
    await auth().GET(new Request(url));
    log.mockClear();

    // Second sign-up, same email (different case), different password.
    const again = await post("/sign-up/email", { name: "Impostor", email: email.toUpperCase(), password: "impostor-pass-2" });
    expect(again.status).toBe(200); // same response as a real sign-up
    expect(log.mock.calls.some((c) => String(c[0]).includes("[email] verify"))).toBe(false);
    log.mockRestore();

    const users = await db().select().from(authUsers).where(eq(authUsers.email, email));
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("Owner");
    expect((await post("/sign-in/email", { email, password: "impostor-pass-2" })).status).toBe(401);
    expect((await post("/sign-in/email", { email, password: "owner-pass-1" })).status).toBe(200);
  });

  it("requires passwords of at least 8 characters", async () => {
    const short = await post("/sign-up/email", { name: "X", email: `short${Date.now()}@example.com`, password: "seven77" });
    expect(short.status).toBe(400);
    const ok = await post("/sign-up/email", { name: "X", email: `eight${Date.now()}@example.com`, password: "eight888" });
    expect(ok.status).toBe(200);
  });
});

describe("API keys", () => {
  it("rejects malformed, unknown and missing keys with the standard error shape", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    const tampered = key.secret.slice(0, -1) + (key.secret.endsWith("A") ? "B" : "A");
    for (const [k, code] of [
      [undefined, "missing_api_key"],
      ["nope", "invalid_api_key"],
      [tampered, "invalid_api_key"],
    ] as const) {
      const res = await call(listGenerations, { path: "/v1/generations", key: k });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ type: "authentication_error", code });
    }
  });

  it("enforces scopes", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct, "test", ["generations:write"]);
    const res = await call(listGenerations, { path: "/v1/generations", key: key.secret });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("insufficient_scope");
  });

  it("does not let Sandbox accounts create live keys", async () => {
    const acct = await createTestAccount("sandbox");
    await expect(
      createKey({ accountId: acct.accountId, userId: acct.userId }, { name: "x", mode: "live", scopes: ["generations:read"] }),
    ).rejects.toMatchObject({ status: 403, code: "live_keys_not_in_plan" });
  });

  it("records last_used_at", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    expect(key.lastUsedAt).toBeNull();
    await call(listGenerations, { path: "/v1/generations", key: key.secret });
    const { listKeys } = await import("@/server/keys/service");
    const [listed] = await listKeys(acct.accountId);
    expect(listed.lastUsedAt).toBeInstanceOf(Date);
  });
});
