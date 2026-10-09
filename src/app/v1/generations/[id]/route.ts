import { apiRoute } from "@/server/http/api";
import { getGeneration } from "@/server/generations/queries";
import { serializeGeneration } from "@/server/generations/serialize";

export const GET = apiRoute<{ id: string }>("generations:read", async (ctx, { id }) => {
  const row = await getGeneration(ctx.key.accountId, id);
  return { status: 200, body: await serializeGeneration(row) };
});
