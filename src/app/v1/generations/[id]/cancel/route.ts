import { apiRoute } from "@/server/http/api";
import { withIdempotency } from "@/server/http/idempotency";
import { cancelGeneration } from "@/server/generations/cancel";
import { serializeGeneration } from "@/server/generations/serialize";

export const POST = apiRoute<{ id: string }>("generations:write", async (ctx, { id }) =>
  withIdempotency(ctx, { id }, async (tx) => {
    const gen = await cancelGeneration(tx, ctx.key.accountId, id);
    return { status: 200, body: await serializeGeneration(gen) };
  }),
);
