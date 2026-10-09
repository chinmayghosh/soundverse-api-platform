import "./setup-env";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "@/server/db/client";
import { seedPlans } from "@/server/db/seed";
import { ensureBucket } from "@/server/storage/s3";

// Fresh schema for every run. DROP SCHEMA (not TRUNCATE) because the ledger
// trigger deliberately blocks TRUNCATE.
export async function setup() {
  if (!process.env.DATABASE_URL?.includes("test")) {
    throw new Error(`Refusing to reset a non-test database: ${process.env.DATABASE_URL}`);
  }
  await db().execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db().execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db().execute(sql`CREATE SCHEMA public`);
  await migrate(db(), { migrationsFolder: "./drizzle" });
  await seedPlans();
  await ensureBucket();
  await closeDb();
}
