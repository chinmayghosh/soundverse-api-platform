import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { env } from "../env";

// Reserve one paid provider call against LIVE_PROVIDER_MAX_CALLS (protects
// the model budget). Same conditional-upsert pattern as rate limits, so
// concurrent workers can't overshoot the cap. Returns false when exhausted.
export async function reserveProviderCall(provider: string, cap = env().LIVE_PROVIDER_MAX_CALLS): Promise<boolean> {
  const res = await db().execute<{ calls: number }>(sql`
    insert into provider_usage (provider, calls) values (${provider}, 1)
    on conflict (provider) do update set calls = provider_usage.calls + 1
      where provider_usage.calls < ${cap}
    returning calls
  `);
  const row = res.rows[0];
  return !!row && row.calls <= cap;
}
