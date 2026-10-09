import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { POST as cancel } from "@/app/v1/generations/[id]/cancel/route";
import { GET as getOne } from "@/app/v1/generations/[id]/route";
import { GET as list, POST as create } from "@/app/v1/generations/route";
import { GET as usage } from "@/app/v1/usage/route";
import { GET as listEndpoints, POST as createEndpoint } from "@/app/v1/webhook_endpoints/route";
import { claimNext, processJob } from "@/server/jobs/worker";
import {
  ErrorSchema,
  GenerationListSchema,
  GenerationSchema,
  UsageSchema,
  WebhookEndpointCreatedSchema,
  buildOpenApiDocument,
} from "@/server/openapi";
import { MockProvider } from "@/server/providers/mock";
import { call, clearQueue, createTestAccount, createTestKey, genBody, testDeps } from "../helpers";

// The response must parse AND carry no undocumented top-level fields.
function conforms(schema: z.ZodObject, body: unknown) {
  const parsed = schema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(Object.keys(body as object).sort()).toEqual(Object.keys(schema.shape).sort());
}

describe("OpenAPI spec matches behaviour", () => {
  beforeEach(clearQueue);

  it("every documented path + method has a route handler", async () => {
    const doc = buildOpenApiDocument();
    for (const [path, ops] of Object.entries(doc.paths ?? {})) {
      const file = `src/app${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
      expect(existsSync(file), file).toBe(true);
      const mod = await import(/* @vite-ignore */ `@/app${path.replace(/\{(\w+)\}/g, "[$1]")}/route`);
      for (const method of Object.keys(ops as object)) expect(mod[method.toUpperCase()], `${method} ${path}`).toBeTypeOf("function");
    }
  });

  it("real responses conform to the documented schemas", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "test");

    const created = await call(create, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody({ metadata: { ref: "x" } }) });
    conforms(GenerationSchema, created.body);

    await processJob((await claimNext(30))!, testDeps(new MockProvider({ latencyMs: 5, failureRate: 0 })));
    const done = await call(getOne, { path: `/v1/generations/${created.body.id}`, key: key.secret, params: { id: created.body.id } });
    expect(done.body.status).toBe("succeeded");
    conforms(GenerationSchema, done.body);

    conforms(GenerationListSchema, (await call(list, { path: "/v1/generations?limit=1", key: key.secret })).body);
    conforms(UsageSchema, (await call(usage, { path: "/v1/usage", key: key.secret })).body);

    const queued = await call(create, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() });
    conforms(GenerationSchema, (await call(cancel, { method: "POST", path: `/x`, key: key.secret, params: { id: queued.body.id } })).body);

    const ep = await call(createEndpoint, { method: "POST", path: "/v1/webhook_endpoints", key: key.secret, body: { url: "https://93.184.216.34/h" } });
    conforms(WebhookEndpointCreatedSchema, ep.body);
    expect((await call(listEndpoints, { path: "/v1/webhook_endpoints", key: key.secret })).status).toBe(200);

    for (const err of [
      await call(list, { path: "/v1/generations", key: "nope" }),
      await call(create, { method: "POST", path: "/v1/generations", key: key.secret, body: { prompt: "" } }),
      await call(getOne, { path: "/v1/generations/gen_x", key: key.secret, params: { id: "gen_x" } }),
    ]) {
      conforms(ErrorSchema, err.body);
    }
  });
});
