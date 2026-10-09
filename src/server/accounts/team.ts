import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit/log";
import { db } from "../db/client";
import { authUsers, memberships, teamInvites } from "../db/schema";
import { Errors } from "../errors";
import { newId } from "../ids";

// Two roles:
//   owner     - everything: live keys, webhooks, team.
//   developer - read everything; create/rotate/revoke *test* keys only.
export type Role = "owner" | "developer";

interface Owner {
  accountId: string;
  userId: string;
  ip?: string | null;
}

export async function listTeam(accountId: string) {
  const members = await db()
    .select({ userId: memberships.userId, role: memberships.role, email: authUsers.email, name: authUsers.name, since: memberships.createdAt })
    .from(memberships)
    .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
    .where(eq(memberships.accountId, accountId))
    .orderBy(asc(memberships.createdAt));
  const invites = await db()
    .select()
    .from(teamInvites)
    .where(and(eq(teamInvites.accountId, accountId), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt)))
    .orderBy(asc(teamInvites.createdAt));
  return { members, invites };
}

// The invitee signs up (and verifies) with this email to join. Existing users
// already belong to an account and can't be moved (documented limitation).
export async function inviteMember(owner: Owner, input: { email: string; role: Role }) {
  const email = z.email().safeParse(input.email.trim().toLowerCase());
  if (!email.success) throw Errors.invalidRequest("invalid_email", "Enter a valid email address.");
  return db().transaction(async (tx) => {
    const [existingUser] = await tx.select({ id: authUsers.id }).from(authUsers).where(eq(sql`lower(${authUsers.email})`, email.data));
    if (existingUser) {
      throw Errors.conflict("user_exists", "That email already has a Soundverse account; invites only work for new sign-ups.");
    }
    const [dup] = await tx
      .select({ id: teamInvites.id })
      .from(teamInvites)
      .where(and(eq(teamInvites.accountId, owner.accountId), eq(teamInvites.email, email.data), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt)));
    if (dup) throw Errors.conflict("already_invited", "That email already has a pending invite.");
    const [invite] = await tx
      .insert(teamInvites)
      .values({ id: newId("inv"), accountId: owner.accountId, email: email.data, role: input.role, invitedByUserId: owner.userId })
      .returning();
    await writeAudit(tx, {
      accountId: owner.accountId,
      actorUserId: owner.userId,
      action: "member.invited",
      targetType: "invite",
      targetId: invite.id,
      metadata: { email: email.data, role: input.role },
      ip: owner.ip,
    });
    return invite;
  });
}

export async function revokeInvite(owner: Owner, inviteId: string) {
  return db().transaction(async (tx) => {
    const [invite] = await tx
      .update(teamInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(teamInvites.id, inviteId), eq(teamInvites.accountId, owner.accountId), isNull(teamInvites.acceptedAt), isNull(teamInvites.revokedAt)))
      .returning();
    if (!invite) throw Errors.notFound("pending invite");
    await writeAudit(tx, {
      accountId: owner.accountId,
      actorUserId: owner.userId,
      action: "invite.revoked",
      targetType: "invite",
      targetId: invite.id,
      metadata: { email: invite.email },
      ip: owner.ip,
    });
  });
}

// A removed member gets a fresh account of their own on next login.
export async function removeMember(owner: Owner, userId: string) {
  if (userId === owner.userId) throw Errors.conflict("cannot_remove_self", "Owners can't remove themselves.");
  return db().transaction(async (tx) => {
    const [removed] = await tx
      .delete(memberships)
      .where(and(eq(memberships.accountId, owner.accountId), eq(memberships.userId, userId), eq(memberships.role, "developer")))
      .returning();
    if (!removed) throw Errors.notFound("developer in this account");
    await writeAudit(tx, {
      accountId: owner.accountId,
      actorUserId: owner.userId,
      action: "member.removed",
      targetType: "user",
      targetId: userId,
      ip: owner.ip,
    });
  });
}
