import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.js";
import { JobStore, type Clock } from "../src/modules/scheduler/job-store.js";
import { JobExecutor, Scheduler } from "../src/modules/scheduler/scheduler.js";

class FakeClock implements Clock {
  private current: Date;

  constructor(value = "2026-10-24T00:00:00.000Z") { this.current = new Date(value); }
  now(): Date { return new Date(this.current); }
  advance(milliseconds: number): void { this.current = new Date(this.current.getTime() + milliseconds); }
}

describe("SQLite scheduler", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => { db?.close(); db = undefined; });

  function setup() {
    db = new DatabaseSync(":memory:");
    migrateDatabase(db);
    const clock = new FakeClock();
    return { db, clock, store: new JobStore(db, clock), scheduler: new Scheduler(new JobStore(db, clock), clock, { baseBackoffMs: 1_000, maxBackoffMs: 60_000 }) };
  }

  it("enqueues and claims a due job once, while a second worker cannot claim the active lock", () => {
    const { store, clock } = setup();
    const job = store.enqueue({ kind: "activation.scan", payload: { strategy: "no_reply" } });

    const first = store.claimNext("worker-a");
    const second = store.claimNext("worker-b");

    expect(job.status).toBe("queued");
    expect(first).toMatchObject({ id: job.id, kind: "activation.scan", status: "running", attempts: 1, locked_by: "worker-a" });
    expect(second).toBeNull();
    expect(store.listAttempts(job.id)).toHaveLength(1);
    expect(store.get(job.id)?.updated_at).toBe(clock.now().toISOString());
  });

  it("retries with exponential backoff and succeeds on a later attempt", async () => {
    const { store, scheduler, clock } = setup();
    const job = store.enqueue({ kind: "message.send", payload: { customer_id: "local-customer" }, maxAttempts: 3 });
    let calls = 0;

    const first = await scheduler.runOnce("worker-a", async () => { calls += 1; throw new Error("temporary failure"); });
    expect(first).toMatchObject({ jobId: job.id, outcome: "retry", next_run_at: "2026-10-24T00:00:01.000Z" });
    expect(store.get(job.id)).toMatchObject({ status: "retry", attempts: 1, last_error: "temporary failure" });

    expect(await scheduler.runOnce("worker-a", async () => { calls += 1; throw new Error("not due"); })).toBeNull();
    clock.advance(1_000);
    const second = await scheduler.runOnce("worker-a", async () => { calls += 1; });

    expect(second).toMatchObject({ jobId: job.id, outcome: "succeeded" });
    expect(calls).toBe(2);
    expect(store.get(job.id)).toMatchObject({ status: "succeeded", attempts: 2, last_error: null });
    expect(store.listAttempts(job.id).map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
  });

  it("moves a repeatedly failing job to dead-letter after max attempts", async () => {
    const { store, scheduler, clock } = setup();
    const job = store.enqueue({ kind: "activation.scan", payload: {}, maxAttempts: 2 });
    const fail = async () => { throw new Error("permanent failure"); };

    await scheduler.runOnce("worker-a", fail);
    clock.advance(1_000);
    const dead = await scheduler.runOnce("worker-a", fail);

    expect(dead).toMatchObject({ jobId: job.id, outcome: "dead" });
    expect(store.get(job.id)).toMatchObject({ status: "dead", attempts: 2, last_error: "permanent failure", locked_by: null, locked_until: null });
    expect(store.listAttempts(job.id).map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
  });

  it("reclaims an abandoned running job after its lock expires, simulating process restart", () => {
    const { store, clock } = setup();
    const job = store.enqueue({ kind: "activation.scan", payload: {}, lockTtlMs: 5_000 });
    const running = store.claimNext("crashed-worker", 5_000);
    expect(running?.status).toBe("running");

    clock.advance(5_001);
    const reclaimed = store.claimNext("restarted-worker");
    expect(reclaimed).toMatchObject({ id: job.id, status: "running", attempts: 2, locked_by: "restarted-worker" });
    expect(store.listAttempts(job.id).map((attempt) => attempt.status)).toEqual(["abandoned", "started"]);
  });

  it("uses a named SQLite lock to prevent two scheduler leaders", () => {
    const { store, clock } = setup();
    expect(store.acquireLock("scheduler", "worker-a", 5_000)).toBe(true);
    expect(store.acquireLock("scheduler", "worker-b", 5_000)).toBe(false);
    clock.advance(5_001);
    expect(store.acquireLock("scheduler", "worker-b", 5_000)).toBe(true);
    expect(store.releaseLock("scheduler", "worker-b")).toBe(true);
    expect(store.releaseLock("scheduler", "worker-a")).toBe(false);
  });

  it("dispatches jobs through a typed executor registry and rejects unknown kinds", async () => {
    const { store, scheduler } = setup();
    const executor = new JobExecutor();
    const seen: number[] = [];
    executor.register("activation.scan", async (job) => { seen.push(job.id); });
    const known = store.enqueue({ kind: "activation.scan" });
    const unknown = store.enqueue({ kind: "unregistered.kind" });

    expect((await scheduler.runOnce("worker-a", (job) => executor.execute(job))).outcome).toBe("succeeded");
    const failed = await scheduler.runOnce("worker-a", (job) => executor.execute(job));

    expect(seen).toEqual([known.id]);
    expect(failed).toMatchObject({ jobId: unknown.id, outcome: "retry" });
    expect(store.get(unknown.id)).toMatchObject({ last_error: "No executor registered for job kind: unregistered.kind" });
  });
});
