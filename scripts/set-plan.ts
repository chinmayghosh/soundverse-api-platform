// Change an account's plan without a deploy:
//   npm run plan:set -- <account id | user email> <sandbox|starter|growth>
// In Docker: docker compose exec app npm run plan:set -- dev@example.com starter
import "dotenv/config";
import { eq } from "drizzle-orm";
import { changePlan } from "../src/server/accounts/service";
import { closeDb, db } from "../src/server/db/client";
import { authUsers, memberships } from "../src/server/db/schema";

async function main() {
  const [who, planId] = process.argv.slice(2);
  if (!who || !planId) {
    console.error("usage: npm run plan:set -- <account id | email> <plan id>");
    process.exit(2);
  }
  let accountId = who;
  if (who.includes("@")) {
    const [m] = await db()
      .select({ accountId: memberships.accountId })
      .from(authUsers)
      .innerJoin(memberships, eq(memberships.userId, authUsers.id))
      .where(eq(authUsers.email, who));
    if (!m) throw new Error(`no account for ${who}`);
    accountId = m.accountId;
  }
  const plan = await changePlan({ accountId, planId, actorUserId: null });
  console.log(`${accountId} is now on ${plan.name}`);
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(closeDb);
