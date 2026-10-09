import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { writeAudit } from "../audit/log";
import { db } from "../db/client";
import { accounts, memberships, plans, teamInvites } from "../db/schema";
import { Errors } from "../errors";
import { newId } from "../ids";

export const DEFAULT_PLAN_ID = "sandbox";

// Every dashboard user belongs to exactly one tenant account: the one they
// were invited to (if a pending invite matches their *verified* email),
// otherwise a new one they own. Called on dashboard load, which requires a
// verified session, so an unverified sign-up can't claim someone's invite.
// The advisory lock makes concurrent calls produce one membership.
export async function ensureAccountForUser(user: {
  id: string;
  name: string;
  email?: string;
  emailVerified?: boolean;
}) {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"acct:" + user.id}))`);
    const [existing] = await tx
      .select({ accountId: memberships.accountId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id));
    if (existing) return existing;

    if (user.email && user.emailVerified) {
      const [invite] = await tx
        .select()
        .from(teamInvites)
        .where(
          and(
            eq(sql`lower(${teamInvites.email})`, user.email.toLowerCase()),
            isNull(teamInvites.acceptedAt),
            isNull(teamInvites.revokedAt),
          ),
        )
        .orderBy(asc(teamInvites.createdAt))
        .limit(1)
        .for("update");
      if (invite) {
        await tx.insert(memberships).values({ accountId: invite.accountId, userId: user.id, role: invite.role });
        await tx.update(teamInvites).set({ acceptedAt: new Date() }).where(eq(teamInvites.id, invite.id));
        return { accountId: invite.accountId, role: invite.role };
      }
    }

    const accountId = newId("acct");
    await tx.insert(accounts).values({ id: accountId, name: user.name, planId: DEFAULT_PLAN_ID });
    await tx.insert(memberships).values({ accountId, userId: user.id, role: "owner" });
    return { accountId, role: "owner" as const };
  });
}

export async function getAccountWithPlan(accountId: string) {
  const [row] = await db()
    .select({ account: accounts, plan: plans })
    .from(accounts)
    .innerJoin(plans, eq(plans.id, accounts.planId))
    .where(eq(accounts.id, accountId));
  return row;
}

// Plan changes take effect on the next request: limits are always read from
// the plans row at request time, and the billing period is not reset.
export async function changePlan(opts: {
  accountId: string;
  planId: string;
  actorUserId: string | null;
}) {
  return db().transaction(async (tx) => {
    const [plan] = await tx.select().from(plans).where(eq(plans.id, opts.planId));
    if (!plan) throw Errors.invalidRequest("unknown_plan", `No plan "${opts.planId}".`);
    // Same row lock as generation creation, so a plan change never interleaves
    // with a credit check in flight.
    const [acct] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, opts.accountId))
      .for("update");
    if (!acct) throw Errors.notFound("account");
    await tx.update(accounts).set({ planId: plan.id }).where(eq(accounts.id, acct.id));
    await writeAudit(tx, {
      accountId: acct.id,
      actorUserId: opts.actorUserId,
      action: "plan.changed",
      targetType: "account",
      targetId: acct.id,
      metadata: { from: acct.planId, to: plan.id },
    });
    return plan;
  });
}
