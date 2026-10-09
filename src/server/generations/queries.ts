import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../db/client";
import { generations } from "../db/schema";
import { Errors } from "../errors";

export const GENERATION_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

// Every read is scoped by account. Another tenant's id yields the same 404 as
// a nonexistent one, so ids cannot be probed across accounts.
export async function getGeneration(accountId: string, id: string) {
  const [row] = await db()
    .select()
    .from(generations)
    .where(and(eq(generations.id, id), eq(generations.accountId, accountId)));
  if (!row) throw Errors.notFound("generation");
  return row;
}

// Cursor pagination on the ULID id (time-ordered), newest first.
export async function listGenerations(
  accountId: string,
  opts: { limit: number; status?: GenerationStatus; startingAfter?: string },
) {
  const rows = await db()
    .select()
    .from(generations)
    .where(
      and(
        eq(generations.accountId, accountId),
        opts.status ? eq(generations.status, opts.status) : undefined,
        opts.startingAfter ? lt(generations.id, opts.startingAfter) : undefined,
      ),
    )
    .orderBy(desc(generations.id))
    .limit(opts.limit + 1);
  const hasMore = rows.length > opts.limit;
  return { rows: rows.slice(0, opts.limit), hasMore };
}
