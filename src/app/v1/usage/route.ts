import { getUsage } from "@/server/billing/usage";
import { apiRoute } from "@/server/http/api";

export const GET = apiRoute("usage:read", async (ctx) => ({
  status: 200,
  body: await getUsage(ctx.key.accountId),
}));
