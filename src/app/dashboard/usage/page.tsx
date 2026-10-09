import { desc, eq } from "drizzle-orm";
import { requireDashboardWithPlan } from "@/server/auth/session";
import { getUsage } from "@/server/billing/usage";
import { db } from "@/server/db/client";
import { apiKeys, ledgerEntries } from "@/server/db/schema";

// Everything on this page is read from the append-only ledger.
export default async function UsagePage() {
  const { account } = await requireDashboardWithPlan();
  const usage = await getUsage(account.id);
  const recent = await db()
    .select({ entry: ledgerEntries, prefix: apiKeys.prefix })
    .from(ledgerEntries)
    .innerJoin(apiKeys, eq(apiKeys.id, ledgerEntries.apiKeyId))
    .where(eq(ledgerEntries.accountId, account.id))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(50);
  const total = usage.credits.used + usage.credits.overage;

  return (
    <section className="space-y-8 text-sm">
      <h1 className="text-xl font-semibold">Usage · {usage.period}</h1>
      <p>
        {usage.credits.used.toLocaleString()} allowance credits used of {usage.credits.allowance.toLocaleString()},{" "}
        {usage.credits.remaining.toLocaleString()} remaining, {usage.credits.overage.toLocaleString()} overage. Test-key
        jobs are free and don&apos;t appear here.
      </p>

      <div className="grid gap-8 md:grid-cols-2">
        <Table
          title="By API key"
          head={["Key", "Name", "Credits"]}
          rows={usage.by_key.map((k) => [<code key="p">{k.prefix}…</code>, k.name, k.credits.toLocaleString()])}
          foot={["Total", "", total.toLocaleString()]}
        />
        <Table
          title="By day (UTC)"
          head={["Day", "Credits"]}
          rows={usage.by_day.map((d) => [d.day, d.credits.toLocaleString()])}
          foot={["Total", total.toLocaleString()]}
        />
      </div>

      <Table
        title="Ledger (latest 50 entries)"
        head={["When (UTC)", "Kind", "Generation", "Key", "Allowance", "Overage"]}
        rows={recent.map(({ entry, prefix }) => [
          entry.createdAt.toISOString().replace("T", " ").slice(0, 19),
          entry.kind,
          <code key="g">{entry.generationId}</code>,
          <code key="k">{prefix}…</code>,
          String(entry.allowanceCredits),
          String(entry.overageCredits),
        ])}
      />
    </section>
  );
}

function Table(props: { title: string; head: string[]; rows: React.ReactNode[][]; foot?: string[] }) {
  return (
    <div className="overflow-x-auto">
      <h2 className="mb-2 font-medium">{props.title}</h2>
      <table className="w-full text-left">
        <thead className="text-neutral-500">
          <tr>{props.head.map((h) => <th key={h} className="py-1 pr-4">{h}</th>)}</tr>
        </thead>
        <tbody>
          {props.rows.length === 0 && (
            <tr><td colSpan={props.head.length} className="py-2 text-neutral-500">Nothing yet.</td></tr>
          )}
          {props.rows.map((r, i) => (
            <tr key={i} className="border-t border-neutral-200 dark:border-neutral-800">
              {r.map((c, j) => <td key={j} className="py-1 pr-4">{c}</td>)}
            </tr>
          ))}
        </tbody>
        {props.foot && props.rows.length > 0 && (
          <tfoot className="font-medium">
            <tr className="border-t border-neutral-400">{props.foot.map((f, i) => <td key={i} className="py-1 pr-4">{f}</td>)}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
