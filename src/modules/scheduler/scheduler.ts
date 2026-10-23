import { JobStore, type Clock, type JobRecord } from "./job-store.js";

export interface SchedulerOptions { baseBackoffMs?: number; maxBackoffMs?: number; lockTtlMs?: number }
export type JobHandler = (job: JobRecord) => Promise<void> | void;

export class JobExecutor {
  private readonly handlers = new Map<string, JobHandler>();

  register(kind: string, handler: JobHandler): void {
    if (!kind.trim()) throw new Error("Job kind is required");
    this.handlers.set(kind, handler);
  }

  async execute(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) throw new Error(`No executor registered for job kind: ${job.kind}`);
    await handler(job);
  }
}

export interface RunResult {
  jobId: number;
  outcome: "succeeded" | "retry" | "dead";
  next_run_at?: string | null;
}

export class Scheduler {
  private readonly options: Required<SchedulerOptions>;

  constructor(private readonly store: JobStore, private readonly clock: Clock, options: SchedulerOptions = {}) {
    this.options = { baseBackoffMs: options.baseBackoffMs ?? 1_000, maxBackoffMs: options.maxBackoffMs ?? 300_000, lockTtlMs: options.lockTtlMs ?? 30_000 };
  }

  async runOnce(owner: string, handler: JobHandler): Promise<RunResult | null> {
    const job = this.store.claimNext(owner, this.options.lockTtlMs);
    if (!job) return null;
    try {
      await handler(job);
      this.store.succeed(job.id, owner);
      return { jobId: job.id, outcome: "succeeded" };
    } catch (error) {
      const result = this.store.fail(job.id, owner, error, this.options.baseBackoffMs, this.options.maxBackoffMs);
      return { jobId: job.id, outcome: result.dead ? "dead" : "retry", next_run_at: result.next_run_at };
    }
  }

  now(): Date { return this.clock.now(); }
}
