import Link from "next/link";
import { requireDashboardWithPlan } from "@/server/auth/session";
import { getUsage } from "@/server/billing/usage";

export default async function OverviewPage() {
  const { plan, account } = await requireDashboardWithPlan();
  const usage = await getUsage(account.id);
  const pct = plan.monthlyCredits ? Math.min(100, (usage.credits.used / plan.monthlyCredits) * 100) : 0;

  const limits: [string, string][] = [
    ["Monthly allowance", `${plan.monthlyCredits.toLocaleString()} credits`],
    ["Parallel generations", String(plan.parallelLimit)],
    ["Requests per hour", plan.reqPerHour.toLocaleString()],
    ["Requests per day", plan.reqPerDay.toLocaleString()],
    ["Licenses", plan.licenses.join(", ")],
    ["Beyond allowance", plan.overageAllowed ? "Allowed, billed as overage" : "Hard stop"],
    ["Live keys", plan.liveKeysAllowed ? "Allowed" : "Test keys only"],
  ];
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{account.name}</h1>
        <p className="text-sm text-neutral-500">Account {account.id}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={`Credits used (${usage.period})`} value={`${usage.credits.used.toLocaleString()} / ${plan.monthlyCredits.toLocaleString()}`}>
          <div className="mt-2 h-2 rounded bg-neutral-200 dark:bg-neutral-800">
            <div className="h-2 rounded bg-neutral-900 dark:bg-white" style={{ width: `${pct}%` }} />
          </div>
        </Stat>
        <Stat label="Remaining" value={usage.credits.remaining.toLocaleString()} />
        <Stat label="Overage (billable)" value={usage.credits.overage.toLocaleString()} />
        <Stat label="Live jobs in progress" value={`${usage.parallel.live_in_progress} / ${plan.parallelLimit}`} />
        <Stat label="Test jobs in progress" value={`${usage.parallel.test_in_progress} / ${plan.parallelLimit}`} />
        <Stat label="Resets" value={new Date(usage.period_end).toISOString().slice(0, 10)} />
      </div>

      <div>
        <h2 className="mb-2 font-medium">Plan: {plan.name}</h2>
        <table className="text-sm">
          <tbody>
            {limits.map(([k, v]) => (
              <tr key={k}>
                <td className="py-1 pr-6 text-neutral-500">{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm">
        New here? Create a <Link className="underline" href="/dashboard/keys">test key</Link>, then follow the{" "}
        <a className="underline" href="/docs">quickstart</a>.
      </p>
    </section>
  );
}

function Stat({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="rounded border border-neutral-300 p-3 dark:border-neutral-700">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {children}
    </div>
  );
}
