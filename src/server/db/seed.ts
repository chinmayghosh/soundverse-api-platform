import { db } from "./client";
import { plans } from "./schema";

// The illustrative plans from the brief. Inserted only if missing, so edits
// made to plan rows in the database survive restarts.
export const DEFAULT_PLANS: (typeof plans.$inferInsert)[] = [
  {
    id: "sandbox",
    name: "Sandbox",
    monthlyCredits: 0,
    parallelLimit: 1,
    reqPerHour: 60,
    reqPerDay: 500,
    licenses: ["royalty_free"],
    overageAllowed: false,
    liveKeysAllowed: false,
  },
  {
    id: "starter",
    name: "Starter",
    monthlyCredits: 200,
    parallelLimit: 3,
    reqPerHour: 300,
    reqPerDay: 3000,
    licenses: ["royalty_free", "sync"],
    overageAllowed: false,
    liveKeysAllowed: true,
  },
  {
    id: "growth",
    name: "Growth",
    monthlyCredits: 2000,
    parallelLimit: 10,
    reqPerHour: 2000,
    reqPerDay: 30000,
    licenses: ["royalty_free", "sync", "full_ownership"],
    overageAllowed: true,
    liveKeysAllowed: true,
  },
];

export async function seedPlans() {
  await db().insert(plans).values(DEFAULT_PLANS).onConflictDoNothing();
}
