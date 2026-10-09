import Link from "next/link";
import { requireDashboardWithPlan } from "@/server/auth/session";
import { SignOutButton } from "./sign-out";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const ctx = await requireDashboardWithPlan();
  const nav = [
    ["/dashboard", "Overview"],
    ["/dashboard/keys", "API keys"],
    ["/dashboard/generations", "Generations"],
    ["/dashboard/usage", "Usage"],
    ["/dashboard/webhooks", "Webhooks"],
    ["/dashboard/team", "Team"],
    ["/dashboard/audit", "Audit log"],
  ] as const;
  return (
    <div className="mx-auto w-full max-w-5xl p-4">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-300 pb-3 dark:border-neutral-700">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-semibold">Soundverse API</span>
          {nav.map(([href, label]) => (
            <Link key={href} href={href} className="text-sm hover:underline">
              {label}
            </Link>
          ))}
          <a href="/docs" className="text-sm hover:underline">
            Docs
          </a>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span>
            {ctx.user.email} · <b>{ctx.plan.name}</b> plan · {ctx.role}
          </span>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
