import { z } from "zod";
import { apiRoute, parseOrThrow } from "@/server/http/api";
import { GENERATION_STATUSES, listGenerations } from "@/server/generations/queries";
import { serializeGeneration } from "@/server/generations/serialize";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(GENERATION_STATUSES).optional(),
  starting_after: z.string().regex(/^gen_[0-9A-Z]{26}$/).optional(),
});

export const GET = apiRoute("generations:read", async (ctx) => {
  const q = parseOrThrow(ListQuery, Object.fromEntries(ctx.url.searchParams));
  const { rows, hasMore } = await listGenerations(ctx.key.accountId, {
    limit: q.limit,
    status: q.status,
    startingAfter: q.starting_after,
  });
  const data = await Promise.all(rows.map(serializeGeneration));
  return {
    status: 200,
    body: {
      object: "list",
      data,
      has_more: hasMore,
      next_cursor: hasMore ? data[data.length - 1].id : null,
    },
  };
});
