import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client";
import { seedPlans } from "./seed";
import { ensureBucket } from "../storage/s3";

async function main() {
  await migrate(db(), { migrationsFolder: "./drizzle" });
  await seedPlans();
  await ensureBucket();
  console.log("migrations applied, plans seeded, bucket ready");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);
