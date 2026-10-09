import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { webhookDeliveries } from "@/server/db/schema";
import { claimNext, processJob } from "@/server/jobs/worker";
import { RETRY_SCHEDULE_SEC, deliverDue, type DeliveryDeps } from "@/server/webhooks/deliveries";
import { verifyWebhook } from "@/server/webhooks/crypto";
import { createEndpoint } from "@/server/webhooks/endpoints";
import { call, clearQueue, createTestAccount, createTestKey, genBody, scriptedProvider, testDeps } from "../helpers";

// A fake customer endpoint we can take down and bring back.
let server: Server;
let port: number;
let mode: "down" | "up" | "redirect" = "up";
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (mode === "down") return void res.writeHead(503).end();
      if (mode === "redirect") return void res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  received.length = 0;
  mode = "up";
  await clearQueue();
  // Park deliveries left by other tests so only ours are due.
  await db().update(webhookDeliveries).set({ status: "failed" }).where(eq(webhookDeliveries.status, "pending"));
});

// 127.0.0.1 is exempted explicitly here; production has no exemptions.
const deps = (over: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
  allowHttp: true,
  allowPrivateHosts: ["127.0.0.1"],
  timeoutMs: 2000,
  schedule: RETRY_SCHEDULE_SEC,
  ...over,
});

async function finishedJobWithEndpoint() {
  const acct = await createTestAccount("starter");
  const key = await createTestKey(acct, "test");
  const { secret } = await db().transaction((tx) =>
    createEndpoint(tx, { accountId: acct.accountId, userId: acct.userId }, { url: `http://127.0.0.1:${port}/hook` }),
  );
  const r = await call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() });
  const job = await claimNext(30);
  await processJob(job!, testDeps(scriptedProvider(["ok"]).provider));
  const [delivery] = await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.accountId, acct.accountId));
  return { secret, jobId: r.body.id as string, deliveryId: delivery.id };
}

const getDelivery = async (id: string) => (await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)))[0];
const secondsUntilNext = async (id: string) =>
  Number(
    (
      await db().execute<{ s: number }>(
        sql`select extract(epoch from next_attempt_at - now())::float as s from webhook_deliveries where id = ${id}`,
      )
    ).rows[0].s,
  );
const fastForward = (id: string) =>
  db().update(webhookDeliveries).set({ nextAttemptAt: sql`now()` }).where(eq(webhookDeliveries.id, id));

// Scenario 10: a webhook endpoint is down for 10 minutes, then recovers.
// Separately, someone re-sends a captured webhook payload a day later.
describe("scenario 10: webhook outage, recovery and replay", () => {
  it("backs off while the endpoint is down and delivers the same signed event once it recovers", async () => {
    const { secret, jobId, deliveryId } = await finishedJobWithEndpoint();

    mode = "down";
    for (let i = 0; i < 4; i++) {
      expect(await deliverDue(deps())).toBe(1);
      const d = await getDelivery(deliveryId);
      expect(d).toMatchObject({ status: "pending", attempts: i + 1, lastStatusCode: 503 });
      // Waits per the schedule (10s, 30s, 1m, 2m...) before the next try.
      expect(await secondsUntilNext(deliveryId)).toBeGreaterThan(RETRY_SCHEDULE_SEC[i] - 2);
      expect(await secondsUntilNext(deliveryId)).toBeLessThanOrEqual(RETRY_SCHEDULE_SEC[i]);
      expect(await deliverDue(deps())).toBe(0); // not due yet
      await fastForward(deliveryId); // let time pass
    }

    mode = "up";
    expect(await deliverDue(deps())).toBe(1);
    expect(await getDelivery(deliveryId)).toMatchObject({ status: "succeeded", attempts: 5, lastStatusCode: 200 });
    expect(await deliverDue(deps())).toBe(0); // never re-sent after success

    // Every attempt carried the same event id; the final one verifies.
    expect(new Set(received.map((r) => r.headers["soundverse-event-id"])).size).toBe(1);
    const last = received.at(-1)!;
    expect(last.headers["soundverse-delivery-attempt"]).toBe("5");
    expect(() => verifyWebhook(secret, last.headers["soundverse-signature"] as string, last.body)).not.toThrow();
    const event = JSON.parse(last.body);
    expect(event).toMatchObject({ type: "generation.succeeded", data: { id: jobId, status: "succeeded" } });
    expect(event.data.output.audio_url).toMatch(/^http/); // minted fresh at send time

    // A captured payload replayed a day later fails verification.
    const tomorrow = Math.floor(Date.now() / 1000) + 86_400;
    expect(() =>
      verifyWebhook(secret, last.headers["soundverse-signature"] as string, last.body, { now: tomorrow }),
    ).toThrow(/tolerance/);
  });

  it("gives up after the last scheduled retry", async () => {
    const { deliveryId } = await finishedJobWithEndpoint();
    mode = "down";
    const schedule = [0, 0];
    for (let i = 0; i < 3; i++) {
      await fastForward(deliveryId);
      await deliverDue(deps({ schedule }));
    }
    expect(await getDelivery(deliveryId)).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("does not follow redirects (a 3xx is a failed attempt)", async () => {
    const { deliveryId } = await finishedJobWithEndpoint();
    mode = "redirect";
    await deliverDue(deps());
    expect(received).toHaveLength(1);
    expect(await getDelivery(deliveryId)).toMatchObject({ status: "pending", lastStatusCode: 302 });
  });
});
