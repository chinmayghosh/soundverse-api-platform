import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ensureAccountForUser, getAccountWithPlan } from "../accounts/service";
import { getAuth } from "./auth";

export interface DashboardContext {
  user: { id: string; name: string; email: string };
  accountId: string;
  role: "owner" | "developer";
  ip: string | null;
}

// For dashboard pages and server actions. Redirects to /login without a session.
export async function requireDashboard(): Promise<DashboardContext> {
  const h = await headers();
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) redirect("/login");
  const { accountId, role } = await ensureAccountForUser(session.user);
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    accountId,
    role,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}

export async function requireDashboardWithPlan() {
  const ctx = await requireDashboard();
  const row = await getAccountWithPlan(ctx.accountId);
  return { ...ctx, account: row.account, plan: row.plan };
}
