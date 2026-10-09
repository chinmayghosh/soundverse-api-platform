import { requireDashboardWithPlan } from "@/server/auth/session";

export default async function OverviewPage() {
  const { plan, account } = await requireDashboardWithPlan();
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
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{account.name}</h1>
      <p className="text-sm text-neutral-500">Account id: {account.id}</p>
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
    </section>
  );
}
