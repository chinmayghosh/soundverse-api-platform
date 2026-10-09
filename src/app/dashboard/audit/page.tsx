import { desc, eq } from "drizzle-orm";
import { requireDashboard } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { auditLog, authUsers } from "@/server/db/schema";

export default async function AuditPage() {
  const ctx = await requireDashboard();
  const rows = await db()
    .select({ entry: auditLog, email: authUsers.email })
    .from(auditLog)
    .leftJoin(authUsers, eq(authUsers.id, auditLog.actorUserId))
    .where(eq(auditLog.accountId, ctx.accountId))
    .orderBy(desc(auditLog.createdAt))
    .limit(200);
  return (
    <section className="space-y-4 text-sm">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="text-neutral-500">Who created, rotated or revoked keys, changed the plan or webhook endpoints, and when.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-neutral-500">
            <tr>{["When (UTC)", "Who", "Action", "Target", "Details", "IP"].map((h) => <th key={h} className="py-1 pr-4">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="py-2 text-neutral-500">Nothing yet.</td></tr>}
            {rows.map(({ entry, email }) => (
              <tr key={entry.id} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-1 pr-4 whitespace-nowrap">{entry.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                <td className="pr-4">{email ?? (entry.metadata.viaApiKey ? "API key" : "system")}</td>
                <td className="pr-4 font-mono">{entry.action}</td>
                <td className="pr-4 font-mono text-xs">{entry.targetId}</td>
                <td className="pr-4 font-mono text-xs">{JSON.stringify(entry.metadata)}</td>
                <td className="pr-4">{entry.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
