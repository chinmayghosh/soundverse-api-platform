import { apiRoute } from "@/server/http/api";
import { deleteEndpoint, serializeEndpoint } from "@/server/webhooks/endpoints";

export const DELETE = apiRoute<{ id: string }>("webhooks:manage", async (ctx, { id }) => {
  const endpoint = await deleteEndpoint({ accountId: ctx.key.accountId, userId: null, apiKeyId: ctx.key.id }, id);
  return { status: 200, body: { ...serializeEndpoint(endpoint), deleted: true } };
});
