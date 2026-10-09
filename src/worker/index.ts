import "dotenv/config";
import { closeDb } from "../server/db/client";
import { env } from "../server/env";
import { Runner } from "../server/jobs/runner";
import { defaultDeps } from "../server/jobs/worker";

const runner = new Runner(defaultDeps(), env().WORKER_CONCURRENCY);
runner.start();
console.log(`worker: started (concurrency ${env().WORKER_CONCURRENCY}, live provider ${env().LIVE_PROVIDER})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    console.log(`worker: ${signal}, draining`);
    await runner.stop();
    await closeDb();
    process.exit(0);
  });
}
