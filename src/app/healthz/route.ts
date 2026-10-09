import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export async function GET() {
  await db().execute(sql`select 1`);
  return Response.json({ ok: true });
}
