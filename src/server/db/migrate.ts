import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client";
import { seedPlans } from "./seed";

async function main() {
  await migrate(db(), { migrationsFolder: "./drizzle" });
  await seedPlans();
  console.log("migrations applied, plans seeded");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);
