"use server";
import { revalidatePath } from "next/cache";
import { inviteMember, removeMember, revokeInvite, type Role } from "@/server/accounts/team";
import { requireOwner } from "@/server/auth/session";
import { ApiError } from "@/server/errors";

export type TeamActionResult = { ok: boolean; message: string };

async function run(fn: () => Promise<string>): Promise<TeamActionResult> {
  try {
    const message = await fn();
    revalidatePath("/dashboard/team");
    return { ok: true, message };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function inviteAction(email: string, role: Role): Promise<TeamActionResult> {
  return run(async () => {
    const ctx = await requireOwner();
    await inviteMember({ accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip }, { email, role });
    return `Invited ${email} as ${role}. They join by signing up with that email.`;
  });
}

export async function revokeInviteAction(inviteId: string): Promise<TeamActionResult> {
  return run(async () => {
    const ctx = await requireOwner();
    await revokeInvite({ accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip }, inviteId);
    return "Invite revoked.";
  });
}

export async function removeMemberAction(userId: string): Promise<TeamActionResult> {
  return run(async () => {
    const ctx = await requireOwner();
    await removeMember({ accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip }, userId);
    return "Member removed.";
  });
}
