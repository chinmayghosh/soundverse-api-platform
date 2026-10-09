import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureAccountForUser } from "@/server/accounts/service";
import { inviteMember, removeMember } from "@/server/accounts/team";
import { db } from "@/server/db/client";
import { authUsers, memberships } from "@/server/db/schema";
import { newId } from "@/server/ids";
import { createKey, revokeKey, rotateKey } from "@/server/keys/service";
import { createTestAccount, createTestKey } from "../helpers";

async function newUser(email: string, verified: boolean) {
  const id = newId("usr");
  await db().insert(authUsers).values({ id, name: "Invitee", email, emailVerified: verified });
  return { id, name: "Invitee", email, emailVerified: verified };
}

describe("team members and roles", () => {
  it("an invited email joins the inviting account as developer once verified", async () => {
    const owner = await createTestAccount("starter");
    const email = `dev-${Date.now()}@example.com`;
    await inviteMember({ accountId: owner.accountId, userId: owner.userId }, { email, role: "developer" });

    const u = await newUser(email, true);
    expect(await ensureAccountForUser(u)).toEqual({ accountId: owner.accountId, role: "developer" });
  });

  it("an unverified sign-up with an invited email cannot claim the invite", async () => {
    const owner = await createTestAccount("starter");
    const email = `squat-${Date.now()}@example.com`;
    await inviteMember({ accountId: owner.accountId, userId: owner.userId }, { email, role: "owner" });

    const squatter = await newUser(email, false);
    const got = await ensureAccountForUser(squatter);
    expect(got.accountId).not.toBe(owner.accountId);
  });

  it("developers manage test keys only", async () => {
    const owner = await createTestAccount("starter");
    const live = await createTestKey(owner, "live");
    const dev = { accountId: owner.accountId, userId: owner.userId, role: "developer" as const };

    await expect(createKey(dev, { name: "x", mode: "test", scopes: ["generations:read"] })).resolves.toBeDefined();
    await expect(createKey(dev, { name: "x", mode: "live", scopes: ["generations:read"] })).rejects.toMatchObject({ code: "owner_only" });
    await expect(revokeKey(dev, live.id)).rejects.toMatchObject({ code: "owner_only" });
    await expect(rotateKey(dev, live.id)).rejects.toMatchObject({ code: "owner_only" });
  });

  it("refuses invites for existing users and lets owners remove developers", async () => {
    const owner = await createTestAccount("starter");
    const other = await createTestAccount("starter");
    const [otherUser] = await db().select().from(authUsers).where(eq(authUsers.id, other.userId));
    await expect(
      inviteMember({ accountId: owner.accountId, userId: owner.userId }, { email: otherUser.email, role: "developer" }),
    ).rejects.toMatchObject({ code: "user_exists" });

    const email = `rm-${Date.now()}@example.com`;
    await inviteMember({ accountId: owner.accountId, userId: owner.userId }, { email, role: "developer" });
    const u = await newUser(email, true);
    await ensureAccountForUser(u);
    await removeMember({ accountId: owner.accountId, userId: owner.userId }, u.id);
    expect(await db().select().from(memberships).where(eq(memberships.userId, u.id))).toEqual([]);
    await expect(removeMember({ accountId: owner.accountId, userId: owner.userId }, owner.userId)).rejects.toMatchObject({
      code: "cannot_remove_self",
    });
  });
});
