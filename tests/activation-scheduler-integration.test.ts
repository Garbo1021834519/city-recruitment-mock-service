import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.js";
import { JobStore, type Clock } from "../src/modules/scheduler/job-store.js";
import { JobExecutor, Scheduler } from "../src/modules/scheduler/scheduler.js";
import { ActivationJobService } from "../src/modules/activation/activation.jobs.js";
import type { DifyMessageInput, DifyProvider } from "../src/modules/dify/dify-provider.js";

class FakeClock implements Clock {
  private value = new Date("2026-10-24T12:00:00.000Z");
  now(): Date { return new Date(this.value); }
}

class RecordingProvider implements DifyProvider {
  inputs: DifyMessageInput[] = [];
  async sendMessage(input: DifyMessageInput) { this.inputs.push(input); return { success: true, message: "Dify provider reply", message_id: "provider-msg-1", conversation_id: "provider-conv-1" }; }
  async healthCheck() { return { healthy: true, latency_ms: 1 }; }
}

describe("activation scheduler business wiring", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => { db?.close(); db = undefined; });

  function setup() {
    db = new DatabaseSync(":memory:");
    migrateDatabase(db);
    db.prepare("INSERT INTO activation_strategy_rules(code,enabled,config_json) VALUES ('no_reply',1,?)").run(JSON.stringify({ stale_days: 1, stale_days_max: 3, conversation_max_days: 10, daily_limit: 20, auto_review: false }));
    db.prepare("INSERT INTO activation_strategy_rules(code,enabled,config_json) VALUES ('date_trigger',0,'{}'),('misjudge',0,'{}'),('paused',0,'{}')").run();
    const clock = new FakeClock();
    const store = new JobStore(db, clock);
    const scheduler = new Scheduler(store, clock, { baseBackoffMs: 1_000, lockTtlMs: 5_000 });
    const jobs = new ActivationJobService(db, store, clock);
    const executor = new JobExecutor();
    jobs.registerExecutors(executor);
    return { db, store, scheduler, jobs, executor };
  }

  function seedSilentCustomer(database: DatabaseSync, customerId: number) {
    database.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,created_at,last_msg_at) VALUES (?,?,?,?,?)")
      .run("activation-device", customerId, "本地规则客户", "2026-10-21T12:00:00.000Z", "2026-10-22T12:00:00.000Z");
    database.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,created_at) VALUES (?,?,?,?,?)")
      .run("activation-device", customerId, "outbound", "岗位信息", "2026-10-22T12:00:00.000Z");
  }

  it("scans enabled strategies into one activation record and remains idempotent", async () => {
    const { db: database, store, scheduler, jobs, executor } = setup();
    seedSilentCustomer(database, 501);
    database.prepare("UPDATE activation_strategy_rules SET enabled=1 WHERE code='no_reply'").run();

    const scan = jobs.enqueueScan("no_reply");
    expect(scan.kind).toBe("activation.scan");
    const secondScan = jobs.enqueueScan("no_reply");
    expect((await scheduler.runOnce("worker-a", (job) => executor.execute(job)))?.outcome).toBe("succeeded");
    expect((await scheduler.runOnce("worker-a", (job) => executor.execute(job)))?.outcome).toBe("succeeded");

    const records = database.prepare("SELECT customer_id,strategy,status,reason,next_push_at FROM activation_records WHERE customer_id=501").all() as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ customer_id: 501, strategy: "no_reply", status: "pending_review", reason: "customer_silent_after_outbound" });
    expect(records[0].next_push_at).toEqual(expect.any(String));
    expect(store.get(scan.id)?.status).toBe("succeeded");
  });

  it("auto-reviews a matched record, enqueues message.send, and sends exactly once", async () => {
    const { db: database, store, scheduler, jobs, executor } = setup();
    seedSilentCustomer(database, 502);
    database.prepare("UPDATE activation_strategy_rules SET enabled=1,config_json=? WHERE code='no_reply'")
      .run(JSON.stringify({ stale_days: 1, stale_days_max: 3, conversation_max_days: 10, daily_limit: 20, auto_review: true }));
    database.prepare("INSERT INTO activation_scripts(id,script_name,content,status,data_json) VALUES (?,?,?,?,?)")
      .run(900, "测试语料", "本地自动激活消息", "enabled", JSON.stringify({ category: "测试" }));

    jobs.enqueueScan("no_reply");
    await scheduler.runOnce("worker-a", (job) => executor.execute(job));
    const sendJobs = database.prepare("SELECT id,kind,status,payload_json FROM jobs WHERE kind='message.send'").all() as Array<{ id: number; kind: string; status: string; payload_json: string }>;
    expect(sendJobs).toHaveLength(1);
    expect(JSON.parse(sendJobs[0].payload_json)).toMatchObject({ customer_id: 502 });
    expect(database.prepare("SELECT status FROM activation_records WHERE customer_id=502").get()).toMatchObject({ status: "pending_send" });

    await scheduler.runOnce("worker-a", (job) => executor.execute(job));
    await scheduler.runOnce("worker-a", (job) => executor.execute(job));
    expect(database.prepare("SELECT status,tier FROM activation_records WHERE customer_id=502").get()).toMatchObject({ status: "sent", tier: 1 });
    expect((database.prepare("SELECT COUNT(*) count FROM agent_messages WHERE customer_id=502 AND direction='outbound' AND content<>'岗位信息'").get() as { count: number }).count).toBe(1);
    expect(store.get(sendJobs[0].id)?.status).toBe("succeeded");
  });

  it("does not send an approved record twice when a duplicate message job is retried", async () => {
    const { db: database, scheduler, jobs, executor } = setup();
    database.prepare("INSERT INTO activation_records(id,customer_id,device_code,status,script) VALUES (?,?,?,?,?)")
      .run(700, 503, "activation-device", "pending_send", "手动审批消息");
    jobs.enqueueMessageSend(700);
    jobs.enqueueMessageSend(700);

    await scheduler.runOnce("worker-a", (job) => executor.execute(job));
    await scheduler.runOnce("worker-a", (job) => executor.execute(job));
    await scheduler.runOnce("worker-a", (job) => executor.execute(job));

    expect((database.prepare("SELECT COUNT(*) count FROM agent_messages WHERE customer_id=503 AND direction='outbound'").get() as { count: number }).count).toBe(1);
    expect(database.prepare("SELECT status,tier FROM activation_records WHERE id=700").get()).toMatchObject({ status: "sent", tier: 1 });
  });

  it("uses an injected Dify provider for message jobs and stores the provider reply", async () => {
    const { db: database, store, scheduler } = setup();
    const provider = new RecordingProvider();
    const jobs = new ActivationJobService(database, store, new FakeClock(), provider);
    const executor = new JobExecutor();
    jobs.registerExecutors(executor);
    database.prepare("INSERT INTO agent_devices(id,device_name,status,data_json) VALUES (?,?,?,?)").run(88, "Dify 本地设备", "enabled", JSON.stringify({ device_code: "dify-device", dify_url: "http://dify.local", dify_key: "local-dify-key" }));
    database.prepare("INSERT INTO activation_records(id,customer_id,device_code,status,script) VALUES (?,?,?,?,?)").run(701, 506, "dify-device", "pending_send", "本地触发词");
    jobs.enqueueMessageSend(701);

    await scheduler.runOnce("worker-a", (job) => executor.execute(job));

    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]).toMatchObject({ baseUrl: "http://dify.local", apiKey: "local-dify-key", user: "506", query: "本地触发词" });
    expect(database.prepare("SELECT content FROM agent_messages WHERE customer_id=506 AND direction='outbound'").get()).toMatchObject({ content: "Dify provider reply" });
  });

  it("exposes an admin-only HTTP trigger for a local scheduler scan", async () => {
    const { db: database } = setup();
    seedSilentCustomer(database, 504);
    database.prepare("UPDATE activation_strategy_rules SET enabled=1 WHERE code='no_reply'").run();
    const { buildServer } = await import("../src/server.js");
    const httpApp = buildServer();
    await httpApp.ready();
    try {
      const token = (await httpApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
      const response = await httpApp.inject({ method: "POST", url: "/api/v1/activation/scheduler/run", headers: { authorization: `Bearer ${token}` }, payload: { strategy: "no_reply" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toMatchObject({ outcome: "succeeded" });
    } finally {
      await httpApp.close();
    }
  });
});
