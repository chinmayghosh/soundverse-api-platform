import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
// The type a function receives inside db.transaction(async (tx) => ...).
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// One pool per process. Next dev hot-reloads modules, so park it on globalThis.
const g = globalThis as unknown as { __svPool?: Pool; __svDb?: Db };

export function db(): Db {
  if (!g.__svDb) {
    g.__svPool = new Pool({ connectionString: env().DATABASE_URL, max: 20 });
    g.__svDb = drizzle(g.__svPool, { schema });
  }
  return g.__svDb;
}

export async function closeDb() {
  await g.__svPool?.end();
  g.__svPool = undefined;
  g.__svDb = undefined;
}
