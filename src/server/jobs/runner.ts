import { sleep } from "../providers/mock";
import { claimNext, housekeeping, processJob, reapExpiredLeases, type WorkerDeps } from "./worker";

// Long-running loop for the worker process. Up to `concurrency` jobs at once;
// polls the queue every 500 ms when idle. Jobs live in Postgres, so a restart
// loses nothing: in-flight jobs' leases expire and the reaper requeues them.
export class Runner {
  private running = false;
  private inflight = new Set<Promise<unknown>>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly deps: WorkerDeps,
    private readonly concurrency: number,
  ) {}

  start() {
    this.running = true;
    this.timers.push(setInterval(() => void reapExpiredLeases().then(log("reaper")).catch(warn), 10_000));
    this.timers.push(setInterval(() => void housekeeping().catch(warn), 10 * 60_000));
    void this.loop();
  }

  private async loop() {
    while (this.running) {
      if (this.inflight.size >= this.concurrency) {
        await Promise.race(this.inflight);
        continue;
      }
      let job;
      try {
        job = await claimNext(this.deps.leaseSec);
      } catch (e) {
        warn(e);
        await sleep(2000);
        continue;
      }
      if (!job) {
        await sleep(500);
        continue;
      }
      console.log(`worker: claimed ${job.id} (${job.provider}/${job.model}, claim #${job.attempts})`);
      const p = processJob(job, this.deps)
        .then((outcome) => console.log(`worker: ${job.id} -> ${outcome}`))
        .catch(warn)
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  // Graceful shutdown: stop claiming and give in-flight jobs time to finish.
  // Anything still running after the grace period is recovered via its lease.
  async stop(graceMs = 25_000) {
    this.running = false;
    this.timers.forEach(clearInterval);
    await Promise.race([Promise.allSettled(this.inflight), sleep(graceMs)]);
  }
}

const log = (what: string) => (r: { requeued: number; failed: number }) => {
  if (r.requeued || r.failed) console.log(`worker: ${what} requeued ${r.requeued}, failed ${r.failed}`);
};
const warn = (e: unknown) => console.error("worker:", e);
