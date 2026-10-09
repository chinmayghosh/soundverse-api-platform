import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client";
import { accounts, plans } from "../db/schema";
import { Errors } from "../errors";

type Window = "hour" | "day";

export interface RateLimitState {
  window: Window; // the window closest to its limit
  limit: number;
  remaining: number;
  resetAt: Date;
}

// Fixed UTC windows, counted per account across all of its keys.
//
// Each window is one row; the increment is a conditional upsert:
//   INSERT … ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < limit
// Postgres row-locks the counter during the upsert, so concurrent requests
// serialize on it and the count can never pass the limit. When the WHERE
// fails, no row is returned and the request is rejected without consuming
// quota. Both windows run in one transaction: if the day window rejects, the
// hour increment is rolled back too. Window starts come from the DB clock so
// multiple app instances agree.
export async function consumeRateLimit(accountId: string): Promise<RateLimitState> {
  try {
    return await db().transaction(async (tx) => {
      const [plan] = await tx
        .select({ hour: plans.reqPerHour, day: plans.reqPerDay })
        .from(accounts)
        .innerJoin(plans, eq(plans.id, accounts.planId))
        .where(eq(accounts.id, accountId));
      if (!plan) throw Errors.notFound("account");

      const hour = await bump(tx, accountId, "hour", plan.hour);
      const day = await bump(tx, accountId, "day", plan.day);
      return hour.remaining <= day.remaining ? hour : day;
    });
  } catch (e) {
    if (e instanceof RateLimited) {
      const retryAfter = (e.state.resetAt.getTime() - Date.now()) / 1000;
      const err = Errors.rateLimited(
        e.state.window === "hour" ? "hourly_rate_limit_exceeded" : "daily_rate_limit_exceeded",
        `Rate limit of ${e.state.limit} requests per ${e.state.window} exceeded for this account.`,
        retryAfter,
      );
      Object.assign(err.headers, rateLimitHeaders(e.state));
      throw err;
    }
    throw e;
  }
}

class RateLimited extends Error {
  constructor(readonly state: RateLimitState) {
    super("rate limited");
  }
}

async function bump(tx: Tx, accountId: string, window: Window, limit: number): Promise<RateLimitState> {
  const unit = window === "hour" ? sql.raw("'hour'") : sql.raw("'day'");
  const span = window === "hour" ? sql.raw("interval '1 hour'") : sql.raw("interval '1 day'");
  const res = await tx.execute<{ count: number; reset_at: Date | string }>(sql`
    insert into rate_limit_counters (account_id, "window", window_start, count)
    values (${accountId}, ${window}, date_trunc(${unit}, now() at time zone 'utc') at time zone 'utc', 1)
    on conflict (account_id, "window", window_start)
      do update set count = rate_limit_counters.count + 1
      where rate_limit_counters.count < ${limit}
    returning count, window_start + ${span} as reset_at
  `);
  const row = res.rows[0];
  if (!row || row.count > limit) {
    const [{ reset_at }] = (
      await tx.execute<{ reset_at: Date | string }>(
        sql`select date_trunc(${unit}, now() at time zone 'utc') at time zone 'utc' + ${span} as reset_at`,
      )
    ).rows;
    throw new RateLimited({ window, limit, remaining: 0, resetAt: new Date(reset_at) });
  }
  return { window, limit, remaining: limit - row.count, resetAt: new Date(row.reset_at) };
}

export function rateLimitHeaders(s: RateLimitState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(s.limit),
    "X-RateLimit-Remaining": String(s.remaining),
    "X-RateLimit-Reset": String(Math.ceil(s.resetAt.getTime() / 1000)),
    "X-RateLimit-Window": s.window,
  };
}

