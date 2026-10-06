/**
 * Background worker: job queue, event outbox dispatch and scheduled
 * maintenance. Run one or more replicas; work is claimed with
 * FOR UPDATE SKIP LOCKED so replicas never double-process.
 *
 *   pnpm worker
 */
import { hostname } from "node:os";
import { MODULE_DEFINITIONS } from "@eaop/module-catalog";
import { createPlatform, loadEnv, runRetention } from "@eaop/platform";

const platform = createPlatform(loadEnv(), { modules: MODULE_DEFINITIONS });
await platform.bootstrap();
const workerId = `${hostname()}:${process.pid}`;
const log = platform.logger.child({ component: "worker", workerId });

platform.jobs.register({ type: "maintenance.retention", timeoutMs: 30 * 60_000, async handle() { log.info("retention.done", await runRetention(platform)); } });

let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

const schedules: Array<{ type: string; everyMs: number; next: number }> = [
  { type: "connectors.health_sweep", everyMs: 15 * 60_000, next: 0 },
  { type: "maintenance.retention", everyMs: 24 * 3600_000, next: Date.now() + 60_000 },
  // Module-owned daily retention sweeps (only if the module is installed in this deployment).
  ...["agent_governance.retention", "data_security.retention"].filter((t) => platform.jobs.registeredTypes().includes(t)).map((type) => ({ type, everyMs: 24 * 3600_000, next: Date.now() + 120_000 })),
];

log.info("worker.started", { jobTypes: platform.jobs.registeredTypes() });
while (!stopping) {
  try {
    const now = Date.now();
    for (const s of schedules) {
      if (now >= s.next) {
        // Idempotency key per time-bucket ⇒ exactly one enqueue across all replicas.
        await platform.jobs.enqueue(s.type, {}, { idempotencyKey: `${s.type}:${Math.floor(now / s.everyMs)}` });
        s.next = now + s.everyMs;
      }
    }
    const dispatched = await platform.events.bus.dispatchPending(200);
    const ran = await platform.jobs.runOnce(workerId, { batch: 20 });
    if (dispatched === 0 && ran === 0) await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    await platform.errors.report(err, { source: "worker", severity: "error" });
    await new Promise((r) => setTimeout(r, 5000));
  }
}
log.info("worker.stopping");
await platform.close();
