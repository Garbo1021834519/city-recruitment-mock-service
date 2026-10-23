import type { DatabaseSync } from "node:sqlite";

export interface Clock { now(): Date }

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  lockTtlMs?: number;
}

export interface JobRecord {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "retry" | "succeeded" | "dead";
  run_at: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  locked_by: string | null;
  locked_until: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRecord {
  id: number;
  job_id: number;
  attempt_number: number;
  status: "started" | "succeeded" | "failed" | "abandoned";
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

/**
 * Backend boundary for future Redis/Celery adapters. The SQLite JobStore is
 * the current implementation; Scheduler only depends on this contract.
 */
export interface JobBackend {
  claimNext(owner: string, lockTtlMs?: number): JobRecord | null;
  succeed(jobId: number, owner: string): JobRecord;
  fail(jobId: number, owner: string, error: unknown, baseBackoffMs?: number, maxBackoffMs?: number): { job: JobRecord; dead: boolean; next_run_at: string | null };
}

type JobRow = Omit<JobRecord, "payload"> & { payload_json: string };

function iso(value: Date): string { return value.toISOString(); }

export class JobStore implements JobBackend {
  constructor(private readonly db: DatabaseSync, private readonly clock: Clock) {}

  enqueue(input: EnqueueInput): JobRecord {
    const now = this.clock.now();
    const runAt = input.runAt ?? now;
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 3));
    const result = this.db.prepare(
      "INSERT INTO jobs(kind,payload_json,status,run_at,max_attempts,created_at,updated_at) VALUES (?,?, 'queued',?,?,?,?)",
    ).run(input.kind, JSON.stringify(input.payload ?? {}), iso(runAt), maxAttempts, iso(now), iso(now));
    return this.get(Number(result.lastInsertRowid)) as JobRecord;
  }

  get(id: number): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  listAttempts(jobId: number): AttemptRecord[] {
    return this.db.prepare("SELECT * FROM job_attempts WHERE job_id=? ORDER BY attempt_number").all(jobId) as unknown as AttemptRecord[];
  }

  claimNext(owner: string, lockTtlMs = 30_000): JobRecord | null {
    const now = this.clock.now();
    const nowIso = iso(now);
    const lockedUntil = iso(new Date(now.getTime() + lockTtlMs));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.db.prepare("SELECT id,attempts FROM jobs WHERE status='running' AND locked_until IS NOT NULL AND locked_until<=?").all(nowIso) as Array<{ id: number; attempts: number }>;
      for (const job of expired) {
        this.db.prepare("UPDATE job_attempts SET status='abandoned',finished_at=?,error=COALESCE(error,'worker lock expired') WHERE job_id=? AND attempt_number=? AND status='started'").run(nowIso, job.id, job.attempts);
        this.db.prepare("UPDATE jobs SET status='retry',locked_by=NULL,locked_until=NULL,updated_at=? WHERE id=? AND status='running'").run(nowIso, job.id);
      }
      const row = this.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','retry') AND run_at<=? ORDER BY run_at,id LIMIT 1").get(nowIso) as { id: number } | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      const current = this.db.prepare("SELECT attempts FROM jobs WHERE id=?").get(row.id) as { attempts: number };
      const attemptNumber = Number(current.attempts) + 1;
      this.db.prepare("UPDATE jobs SET status='running',attempts=?,locked_by=?,locked_until=?,last_error=NULL,updated_at=? WHERE id=?").run(attemptNumber, owner, lockedUntil, nowIso, row.id);
      this.db.prepare("INSERT INTO job_attempts(job_id,attempt_number,status,started_at) VALUES (?,?, 'started',?)").run(row.id, attemptNumber, nowIso);
      this.db.exec("COMMIT");
      return this.get(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  succeed(jobId: number, owner: string): JobRecord {
    const nowIso = iso(this.clock.now());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare("SELECT attempts FROM jobs WHERE id=? AND status='running' AND locked_by=?").get(jobId, owner) as { attempts: number } | undefined;
      if (!job) throw new Error("Job is not owned by this worker");
      this.db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=? WHERE job_id=? AND attempt_number=? AND status='started'").run(nowIso, jobId, job.attempts);
      this.db.prepare("UPDATE jobs SET status='succeeded',locked_by=NULL,locked_until=NULL,last_error=NULL,completed_at=?,updated_at=? WHERE id=?").run(nowIso, nowIso, jobId);
      this.db.exec("COMMIT");
      return this.get(jobId) as JobRecord;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  fail(jobId: number, owner: string, error: unknown, baseBackoffMs = 1_000, maxBackoffMs = 300_000): { job: JobRecord; dead: boolean; next_run_at: string | null } {
    const now = this.clock.now();
    const nowIso = iso(now);
    const message = error instanceof Error ? error.message : String(error);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare("SELECT attempts,max_attempts FROM jobs WHERE id=? AND status='running' AND locked_by=?").get(jobId, owner) as { attempts: number; max_attempts: number } | undefined;
      if (!job) throw new Error("Job is not owned by this worker");
      this.db.prepare("UPDATE job_attempts SET status='failed',finished_at=?,error=? WHERE job_id=? AND attempt_number=? AND status='started'").run(nowIso, message, jobId, job.attempts);
      const dead = job.attempts >= job.max_attempts;
      const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, job.attempts - 1));
      const nextRun = dead ? null : iso(new Date(now.getTime() + delay));
      this.db.prepare("UPDATE jobs SET status=?,run_at=COALESCE(?,run_at),last_error=?,locked_by=NULL,locked_until=NULL,completed_at=?,updated_at=? WHERE id=?")
        .run(dead ? "dead" : "retry", nextRun, message, dead ? nowIso : null, nowIso, jobId);
      this.db.exec("COMMIT");
      return { job: this.get(jobId) as JobRecord, dead, next_run_at: nextRun };
    } catch (caught) { this.db.exec("ROLLBACK"); throw caught; }
  }

  acquireLock(name: string, owner: string, ttlMs: number): boolean {
    const now = this.clock.now();
    const nowIso = iso(now);
    const until = iso(new Date(now.getTime() + ttlMs));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT owner,locked_until FROM job_locks WHERE name=?").get(name) as { owner: string; locked_until: string } | undefined;
      if (existing && existing.owner !== owner && existing.locked_until > nowIso) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("INSERT INTO job_locks(name,owner,locked_until,updated_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,locked_until=excluded.locked_until,updated_at=excluded.updated_at").run(name, owner, until, nowIso);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  releaseLock(name: string, owner: string): boolean {
    return Number(this.db.prepare("DELETE FROM job_locks WHERE name=? AND owner=?").run(name, owner).changes) === 1;
  }

  private toRecord(row: JobRow): JobRecord {
    return { ...row, payload: JSON.parse(row.payload_json) as Record<string, unknown> };
  }
}
