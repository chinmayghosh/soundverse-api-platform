import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DELETE } from "@/app/v1/webhook_endpoints/[id]/route";
import { GET, POST } from "@/app/v1/webhook_endpoints/route";
import { POST as createGen } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import { claimNext, processJob } from "@/server/jobs/worker";
import { deliverDue } from "@/server/webhooks/deliveries";
import { createEndpoint, validateWebhookUrl } from "@/server/webhooks/endpoints";
import { call, clearQueue, createTestAccount, createTestKey, genBody, scriptedProvider, testDeps } from "../helpers";

const register = (key: string, url: string, headers?: Record<string, string>) =>
  call(POST, { method: "POST", path: "/v1/webhook_endpoints", key, body: { url }, headers });

// Scenario 11: an account registers http://169.254.169.254/latest/meta-data/.
describe("scenario 11: SSRF via webhook URL", () => {
  beforeEach(clearQueue);

  it("rejects the cloud metadata URL and its disguises with 422, creating nothing", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://localhost/",
      "http://10.0.0.1/",
      "file:///etc/passwd",
    ]) {
      const res = await register(key.secret, url);
      expect(res.status, url).toBe(422);
      expect(res.body.error).toMatchObject({ type: "invalid_request_error", code: "invalid_webhook_url" });
    }
    expect(await db().select().from(webhookEndpoints).where(eq(webhookEndpoints.accountId, acct.accountId))).toEqual([]);
  });

  it("re-checks at delivery time: a hostname that rebinds to a private IP is never contacted", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct, "test");
    const url = "http://rebind.example/hook";
    // At registration the name resolves to a public address...
    await validateWebhookUrl(url, async () => [{ address: "93.184.216.34", family: 4 }]);
    await db().transaction((tx) => createEndpoint(tx, { accountId: acct.accountId, userId: acct.userId }, { url }));
    await call(createGen, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() });
    await processJob((await claimNext(30))!, testDeps(scriptedProvider(["ok"]).provider));

    // ...then the attacker flips DNS to the metadata service.
    await db().update(webhookDeliveries).set({ status: "failed" }).where(sql`account_id <> ${acct.accountId} and status = 'pending'`);
    await deliverDue({
      resolver: async () => [{ address: "169.254.169.254", family: 4 }],
      allowHttp: true,
      allowPrivateHosts: [],
      timeoutMs: 1000,
      schedule: [10],
    });
    const [d] = await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.accountId, acct.accountId));
    expect(d.lastError).toMatch(/^blocked: .*non-public.*169\.254\.169\.254/);
    expect(d.lastStatusCode).toBeNull(); // no request was made
  });

  it("accepts a public URL, shows the secret once, never stores it in plaintext", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    const res = await register(key.secret, "https://93.184.216.34/hooks/soundverse", { "Idempotency-Key": "we-1" });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[0-9A-Za-z]{32}$/);
    const secret = res.body.secret as string;

    const replay = await register(key.secret, "https://93.184.216.34/hooks/soundverse", { "Idempotency-Key": "we-1" });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(res.body.id);
    expect(replay.body.secret).toBeNull();

    const list = await call(GET, { path: "/v1/webhook_endpoints", key: key.secret });
    expect(list.body.data).toHaveLength(1);
    expect(list.text).not.toContain(secret);

    const tables = await db().execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    for (const { table_name } of tables.rows) {
      const r = await db().execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table_name)} t where t::text like ${"%" + secret.slice(6) + "%"}`,
      );
      expect(r.rows[0].n, table_name).toBe(0);
    }

    const del = await call(DELETE, { method: "DELETE", path: `/v1/webhook_endpoints/${res.body.id}`, key: key.secret, params: { id: res.body.id } });
    expect(del.status).toBe(200);
    expect((await call(GET, { path: "/v1/webhook_endpoints", key: key.secret })).body.data).toEqual([]);
    const other = await createTestKey(await createTestAccount());
    expect((await call(DELETE, { method: "DELETE", path: `/v1/webhook_endpoints/${res.body.id}`, key: other.secret, params: { id: res.body.id } })).status).toBe(404);
  });
});
