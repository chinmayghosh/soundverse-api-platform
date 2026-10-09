import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { listKeys, rotateKey } from "@/server/keys/service";
import { createTestAccount, createTestKey } from "../helpers";

// Scenario 1: a key's full secret is never retrievable after creation,
// from the API, the dashboard or the database.
describe("scenario 1: secret shown once", () => {
  async function databaseContains(needle: string) {
    const tables = await db().execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const hits: string[] = [];
    for (const { table_name } of tables.rows) {
      const r = await db().execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table_name)} t where t::text like ${"%" + needle + "%"}`,
      );
      if (r.rows[0].n > 0) hits.push(table_name);
    }
    return hits;
  }

  it("stores only a hash and never returns the secret again", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    const secretPart = key.secret.split("_").pop()!;
    expect(key.secret.startsWith(key.prefix + "_")).toBe(true);

    // Not in any table, in any column (including audit metadata).
    expect(await databaseContains(secretPart)).toEqual([]);

    // Not in what the dashboard key list renders from.
    const listed = JSON.stringify(await listKeys(acct.accountId));
    expect(listed).not.toContain(secretPart);
    expect(listed).not.toContain("secretHash");
    expect(listed).toContain(key.prefix);
  });

  it("rotation returns the new secret once and stores neither secret", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    const rotated = await rotateKey({ accountId: acct.accountId, userId: acct.userId }, key.id);
    for (const s of [key.secret, rotated.secret]) {
      expect(await databaseContains(s.split("_").pop()!)).toEqual([]);
    }
    expect(JSON.stringify(rotated.key)).not.toContain(rotated.secret);
  });
});
