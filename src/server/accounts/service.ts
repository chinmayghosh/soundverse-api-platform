import { eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit/log";
import { db } from "../db/client";
import { accounts, memberships, plans } from "../db/schema";
import { Errors } from "../errors";
import { newId } from "../ids";

export const DEFAULT_PLAN_ID = "sandbox";

// Every dashboard user owns exactly one tenant account. Called from the
// Better Auth sign-up hook and again on dashboard load, so a failed hook
// self-heals. The advisory lock makes concurrent calls create one account.
export async function ensureAccountForUser(user: { id: string; name: string }) {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"acct:" + user.id}))`);
    const [existing] = await tx
      .select({ accountId: memberships.accountId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id));
    if (existing) return existing;

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
