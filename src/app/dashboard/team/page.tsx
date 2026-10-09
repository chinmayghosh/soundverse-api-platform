import { listTeam } from "@/server/accounts/team";
import { requireDashboard } from "@/server/auth/session";
import { TeamClient } from "./team-client";

export default async function TeamPage() {
  const ctx = await requireDashboard();
  const { members, invites } = await listTeam(ctx.accountId);
  return (
    <TeamClient
      isOwner={ctx.role === "owner"}
      selfId={ctx.user.id}
      members={members.map((m) => ({ userId: m.userId, email: m.email, name: m.name, role: m.role }))}
      invites={invites.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt.toISOString() }))}
    />
  );
}
