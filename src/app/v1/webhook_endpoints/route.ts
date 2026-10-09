import { z } from "zod";
import { apiRoute, parseOrThrow, readRawJson } from "@/server/http/api";
import { withIdempotency } from "@/server/http/idempotency";
import { createEndpoint, listEndpoints, serializeEndpoint, validateWebhookUrl } from "@/server/webhooks/endpoints";

const CreateEndpoint = z.object({
  url: z.string().min(1).max(2048),
  description: z.string().max(200).optional(),
});

export const POST = apiRoute("webhooks:manage", async (ctx) => {
  const raw = await readRawJson(ctx.req);
  const input = parseOrThrow(CreateEndpoint, raw);
  // URL validation (incl. DNS) happens before the transaction; the insert and
  // idempotency record commit together.
  await validateWebhookUrl(input.url);
  return withIdempotency(ctx, raw, async (tx) => {
    const { endpoint, secret } = await createEndpoint(
      tx,
      { accountId: ctx.key.accountId, userId: null, apiKeyId: ctx.key.id },
      input,
    );
    const body = serializeEndpoint(endpoint);
    // The signing secret is returned once, here, and never again: an
    // idempotent replay gets secret: null, so it is never stored in plaintext.
    return { status: 201, body: { ...body, secret }, replayBody: { ...body, secret: null } };
  });
});

export const GET = apiRoute("webhooks:manage", async (ctx) => ({
  status: 200,
  body: { object: "list", data: (await listEndpoints(ctx.key.accountId)).map(serializeEndpoint), has_more: false },
}));
