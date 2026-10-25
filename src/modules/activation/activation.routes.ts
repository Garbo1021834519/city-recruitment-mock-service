import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";
import { evaluateActivationRule, summarizeActivationRule, type ActivationRuleContext, type ActivationStrategyCode } from "./activation.rules.js";
import { ACTIVATION_STRATEGY_DEFAULTS, activationStrategyDefault, isActivationStrategyCode, type ActivationStrategyDefinition } from "./activation.strategies.js";
import { JobExecutor, Scheduler } from "../scheduler/scheduler.js";
import { JobStore } from "../scheduler/job-store.js";
import { ActivationJobService } from "./activation.jobs.js";
import { MessageEventService } from "../messaging/message-events.js";
import { canAccessDevice, deviceConstraint, getUserScope } from "../../auth/user-scopes.js";

export async function registerActivationRoutes(app: FastifyInstance, db: DatabaseSync) {
  const deviceScope = (auth: NonNullable<import("fastify").FastifyRequest["auth"]>) => getUserScope(db, auth);
  const jobClock = { now: () => new Date() };
  const jobStore = new JobStore(db, jobClock);
  const jobScheduler = new Scheduler(jobStore, jobClock);
  const activationJobs = new ActivationJobService(db, jobStore, jobClock);
  const jobExecutor = new JobExecutor();
  activationJobs.registerExecutors(jobExecutor);
  const messageEvents = new MessageEventService(db, { webhookSecret: process.env.REA_WEBHOOK_SECRET ?? "local-webhook-secret" });
  type RuntimeStrategy = Omit<ActivationStrategyDefinition, "config" | "enabled"> & Record<string, unknown> & { enabled: boolean };
  const readStrategyConfig = (code: ActivationStrategyCode) => {
    const definition = activationStrategyDefault(code) as ActivationStrategyDefinition;
    const row = db.prepare("SELECT config_json FROM activation_strategy_rules WHERE code=?").get(code) as { config_json: string } | undefined;
    return row ? JSON.parse(row.config_json) as Record<string, unknown> : definition.config;
  };
  const readStrategy = (code: ActivationStrategyCode): RuntimeStrategy => {
    const definition = activationStrategyDefault(code) as ActivationStrategyDefinition;
    const row = db.prepare("SELECT enabled,config_json FROM activation_strategy_rules WHERE code=?").get(code) as { enabled: number; config_json: string } | undefined;
    return { code, description: definition.description, trigger: definition.trigger, ...readStrategyConfig(code), enabled: row ? Boolean(row.enabled) : definition.enabled };
  };
  const publicStrategy = (strategy: ReturnType<typeof readStrategy>) => ({
    code: strategy.code,
    enabled: strategy.enabled,
    description: strategy.description,
    trigger: strategy.trigger,
    daily_limit: Number(strategy.daily_limit ?? 20),
    send_window: Array.isArray(strategy.send_window) ? strategy.send_window : ["09:00", "21:00"],
    cooldown_days: Number(strategy.cooldown_days ?? 14),
    auto_push: strategy.code === "no_reply" ? strategy.auto_push : null,
    ...(strategy.code === "no_reply" ? { stale_days: strategy.stale_days, stale_days_max: strategy.stale_days_max } : {}),
  });
  const readStrategies = () => ACTIVATION_STRATEGY_DEFAULTS.map((strategy) => publicStrategy(readStrategy(strategy.code)));
  const readRuleContext = (customerId: string, strategy: ActivationStrategyCode): ActivationRuleContext => {
    const conversation = db.prepare("SELECT customer_id,device_code,state,recruit_status,created_at,last_msg_at FROM agent_conversations WHERE CAST(customer_id AS TEXT)=? ORDER BY updated_at DESC LIMIT 1")
      .get(customerId) as Record<string, string | number | null> | undefined;
    const messages = db.prepare(`SELECT device_code,customer_id,direction,content,created_at FROM agent_messages WHERE CAST(customer_id AS TEXT)=? ${conversation ? "AND device_code=?" : ""} ORDER BY created_at DESC,id DESC`)
      .all(...(conversation ? [customerId, String(conversation.device_code)] : [customerId])) as Array<Record<string, string | number | null>>;
    const candidateEvents = db.prepare("SELECT customer_id,event_type,event_at,interview_date,status,disqualified_reason FROM candidate_events WHERE customer_id=? ORDER BY event_at DESC,id DESC")
      .all(customerId) as Array<Record<string, string | number | null>>;
    const activation = db.prepare("SELECT created_at FROM activation_records WHERE CAST(customer_id AS TEXT)=? AND strategy=? ORDER BY id DESC LIMIT 1")
      .get(customerId, strategy) as { created_at: string } | undefined;
    return { conversation: conversation ?? null, messages, candidateEvents, lastActivationAt: activation?.created_at ?? null };
  };

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/activation/records", async (request) => { const { pageSize, offset } = parsePagination(request.query); const scope = deviceConstraint(deviceScope(request.auth!), "device_code"); const rows = db.prepare(`SELECT * FROM activation_records WHERE 1=1${scope.sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...scope.values, pageSize, offset); const total = Number((db.prepare(`SELECT COUNT(*) count FROM activation_records WHERE 1=1${scope.sql}`).get(...scope.values) as { count: number }).count); return { items: rows, total }; });
  app.get("/api/v1/activation/dashboard/stats", async (request) => {
    const today = new Date().toISOString().slice(0, 10);
    const scope = deviceConstraint(deviceScope(request.auth!), "device_code");
    const count = (status?: string) => Number((db.prepare(`SELECT COUNT(*) count FROM activation_records WHERE ${status ? "status=? AND " : ""}date(created_at)=date(?)${scope.sql}`).get(...(status ? [status, today, ...scope.values] : [today, ...scope.values])) as { count: number }).count);
    const replied = Number((db.prepare(`SELECT COUNT(*) count FROM agent_messages WHERE direction='inbound' AND date(created_at)=date(?)${scope.sql}`).get(today, ...scope.values) as { count: number }).count);
    const sent = count("sent");
    return { today_pending: count("pending_review") + count("pending_send"), today_sent: sent, today_replied: replied, reply_rate: sent ? replied / sent * 100 : 0, frozen_total: count("frozen"), paused: Boolean((db.prepare("SELECT paused FROM activation_config WHERE id=1").get() as { paused: number } | undefined)?.paused) };
  });
  app.get("/api/v1/activation/dashboard/trend", async (request) => { const scope = deviceConstraint(deviceScope(request.auth!), "device_code"); return { items: Array.from({ length: 14 }, (_, index) => { const date = new Date(Date.now() - (13 - index) * 86400000).toISOString().slice(0, 10); return { date, sent: Number((db.prepare(`SELECT COUNT(*) count FROM activation_records WHERE status='sent' AND date(updated_at)=date(?)${scope.sql}`).get(date, ...scope.values) as { count: number }).count), replied: 0 }; }) }; });
  app.get("/api/v1/activation/dashboard/population", async (request) => { const scope = deviceConstraint(deviceScope(request.auth!), "device_code"); return ["no_reply", "date_trigger", "misjudge", "paused"].map((code, index) => ({ name: ["A策略·无回复激活", "B策略·到期提醒", "C策略·误判捞回", "D策略·暂停求职"][index], value: Number((db.prepare(`SELECT COUNT(*) count FROM activation_records WHERE strategy=?${scope.sql}`).get(code, ...scope.values) as { count: number }).count) })); });
  app.get("/api/v1/activation/dashboard/strategy-effect", async () => ["no_reply", "date_trigger", "misjudge", "paused"].map((code) => ({ code, sent: 0, replied: 0, rate: 0, good: false })));
  app.get("/api/v1/activation/dashboard/feed", async () => ({ items: [] }));
  app.post<{ Body: Record<string, unknown> }>("/api/v1/webhooks/dify", async (request, reply) => {
    const rawBody = JSON.stringify(request.body ?? {});
    const signature = String(request.headers["x-dify-signature"] ?? "");
    const result = messageEvents.handleWebhook(rawBody, signature);
    return reply.code(result.status === "rejected" ? 401 : 200).send(result);
  });
  app.post<{ Body: { strategy?: string } }>("/api/v1/activation/scheduler/run", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required to run activation scheduler" });
    const strategy = typeof request.body?.strategy === "string" && isActivationStrategyCode(request.body.strategy) ? request.body.strategy : undefined;
    if (request.body?.strategy && !strategy) return reply.code(422).send({ detail: "Unknown activation strategy" });
    const job = activationJobs.enqueueScan(strategy);
    const result = await jobScheduler.runOnce(`http-admin-${request.id}`, (claimed) => jobExecutor.execute(claimed));
    return { job_id: job.id, result };
  });
  // Target shape: {auto_review, freeze_days, paused, schedule_time} — booleans,
  // and no daily_limit. SQLite stores the flags as 0/1, hence the Boolean() casts.
  const readActivationConfig = () => {
    const row = db.prepare("SELECT paused,schedule_time,freeze_days,auto_review FROM activation_config WHERE id=1").get() as { paused: number; schedule_time: string; freeze_days: number; auto_review: number };
    return { auto_review: Boolean(row.auto_review), freeze_days: row.freeze_days, paused: Boolean(row.paused), schedule_time: row.schedule_time };
  };
  app.get("/api/v1/activation/config", async () => readActivationConfig());
  app.put<{ Body: { paused?: boolean } }>("/api/v1/activation/config/paused", async (request) => { db.prepare("UPDATE activation_config SET paused=?,updated_at=CURRENT_TIMESTAMP WHERE id=1").run(request.body?.paused ? 1 : 0); return readActivationConfig(); });
  for (const action of ["approve", "skip", "freeze", "run"] as const) {
    app.post<{ Params: { id: string }; Body: { days?: number; reason?: string; script_id?: number } }>(`/api/v1/activation/records/:id/${action}`, async (request, reply) => {
      const record = db.prepare("SELECT device_code FROM activation_records WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
      if (!record || !canAccessDevice(deviceScope(request.auth!), record.device_code)) return reply.code(404).send({ detail: "激活记录不存在" });
      const status = action === "approve" ? "pending_send" : action === "skip" ? "skipped" : action === "freeze" ? "frozen" : "sent";
      const result = db.prepare("UPDATE activation_records SET status=?,reason=COALESCE(?,reason),tier=CASE WHEN ?='sent' THEN tier+1 ELSE tier END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, request.body?.reason ?? null, status, Number(request.params.id));
      return result.changes ? db.prepare("SELECT * FROM activation_records WHERE id=?").get(Number(request.params.id)) : reply.code(404).send({ detail: "激活记录不存在" });
    });
  }
  app.get("/api/v1/activation/strategies", async () => {
    const engine = readActivationConfig();
    return { items: readStrategies(), engine: { auto_review: engine.auto_review, freeze_days: engine.freeze_days, schedule_time: engine.schedule_time } };
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/activation/scripts", async (request) => { const { page, pageSize, offset } = parsePagination(request.query); const rows = db.prepare("SELECT id,content,data_json,status,created_at,updated_at FROM activation_scripts ORDER BY id DESC LIMIT ? OFFSET ?").all(pageSize, offset) as Array<Record<string, unknown>>; const items = rows.map((row) => { const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {}; return { id: row.id, content: row.content, category: data.category ?? "寒暄召回", is_active: row.status === "enabled", used_count: Number(data.used_count ?? 0), last_used_at: data.last_used_at ?? "", updated_at: row.updated_at }; }); const total = Number((db.prepare("SELECT COUNT(*) count FROM activation_scripts").get() as { count: number }).count); const active_total = Number((db.prepare("SELECT COUNT(*) count FROM activation_scripts WHERE status='enabled'").get() as { count: number }).count); return { items, total, active_total, categories: [...new Set(items.map((item) => item.category))] }; });
  app.get("/api/v1/activation/scripts/random", async () => {
    const row = db.prepare("SELECT id,content,data_json FROM activation_scripts WHERE status='enabled' ORDER BY RANDOM() LIMIT 1").get() as { id: number; content: string; data_json: string } | undefined;
    return row ? { id: row.id, content: row.content, category: JSON.parse(row.data_json).category ?? "寒暄召回" } : { detail: "语料库为空" };
  });
  app.put<{ Body: { paused?: boolean; schedule_time?: string; freeze_days?: number; auto_review?: boolean } }>("/api/v1/activation/config", async (request) => { const body = request.body ?? {}; db.prepare("UPDATE activation_config SET paused=COALESCE(?,paused),schedule_time=COALESCE(?,schedule_time),freeze_days=COALESCE(?,freeze_days),auto_review=COALESCE(?,auto_review),updated_at=CURRENT_TIMESTAMP WHERE id=1").run(typeof body.paused === "boolean" ? (body.paused ? 1 : 0) : null, typeof body.schedule_time === "string" ? body.schedule_time : null, typeof body.freeze_days === "number" ? body.freeze_days : null, typeof body.auto_review === "boolean" ? (body.auto_review ? 1 : 0) : null); return readActivationConfig(); });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/activation/strategies/:id", async (request, reply) => {
    const code = request.params.id;
    if (!isActivationStrategyCode(code)) return reply.code(404).send({ detail: "策略不存在" });
    const body = request.body ?? {};
    const current = readStrategy(code);
    const config = { ...readStrategyConfig(code), ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "enabled")) };
    const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
    db.prepare("INSERT INTO activation_strategy_rules(code,enabled,config_json) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled,config_json=excluded.config_json,updated_at=CURRENT_TIMESTAMP")
      .run(code, enabled ? 1 : 0, JSON.stringify(config));
    return publicStrategy(readStrategy(code));
  });
  app.post<{ Params: { id: string }; Body: { customer_id?: number } }>("/api/v1/activation/strategies/:id/test", async (request, reply) => {
    const code = request.params.id;
    if (!isActivationStrategyCode(code)) return reply.code(404).send({ detail: "策略不存在" });
    const rawCustomerId = request.body?.customer_id;
    if (rawCustomerId === undefined || rawCustomerId === null || String(rawCustomerId).trim() === "") return reply.code(422).send({ detail: "customer_id is required" });
    const customerId = String(rawCustomerId).trim();
    const strategy = readStrategy(code);
    const globallyPaused = Boolean((db.prepare("SELECT paused FROM activation_config WHERE id=1").get() as { paused: number } | undefined)?.paused);
    const context = readRuleContext(customerId, code);
    if (request.auth?.role !== "admin" && (!context.conversation || !canAccessDevice(deviceScope(request.auth!), String(context.conversation.device_code ?? "")))) return reply.code(404).send({ detail: "客户不存在或无权访问" });
    const evaluated = evaluateActivationRule({ strategy: code, context, config: { ...strategy, enabled: strategy.enabled }, globallyPaused });
    return { success: true, strategy_id: code, customer_id: customerId, ...evaluated, summary: summarizeActivationRule(code, context, evaluated) };
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/activation/devices/:id", async (request, reply) => {
    // Target rejects non-admin device writes with 403 before any lookup.
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "无权操作该设备" });
    const body = request.body ?? {}; const result = db.prepare("UPDATE activation_devices SET device_name=COALESCE(?,device_name),status=COALESCE(?,status),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(typeof body.name === "string" ? body.name : null, typeof body.enabled === "boolean" ? (body.enabled ? "enabled" : "disabled") : null, JSON.stringify(body), Number(request.params.id)); return result.changes ? { success: true, ...body } : reply.code(404).send({ detail: "激活设备不存在" }); });
  app.post<{ Body: { device_codes?: string[]; enabled?: boolean } }>("/api/v1/activation/devices/batch-toggle", async (request) => ({ success: true, updated: Array.isArray(request.body?.device_codes) ? request.body.device_codes.length : 0 }));
  app.post<{ Body: Record<string, unknown> }>("/api/v1/activation/scripts", async (request) => { const body = request.body ?? {}; const result = db.prepare("INSERT INTO activation_scripts(script_name,content,status,data_json) VALUES (?,?,?,?) RETURNING *").get(String(body.category ?? "语料"), String(body.content ?? ""), body.is_active === false ? "disabled" : "enabled", JSON.stringify(body)); return result; });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/activation/scripts/:id", async (request, reply) => { const body = request.body ?? {}; const result = db.prepare("UPDATE activation_scripts SET content=COALESCE(?,content),status=COALESCE(?,status),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(typeof body.content === "string" ? body.content : null, typeof body.is_active === "boolean" ? (body.is_active ? "enabled" : "disabled") : null, JSON.stringify(body), Number(request.params.id)); return result.changes ? db.prepare("SELECT id,content,status,data_json FROM activation_scripts WHERE id=?").get(Number(request.params.id)) : reply.code(404).send({ detail: "语料不存在" }); });
  app.delete<{ Params: { id: string } }>("/api/v1/activation/scripts/:id", async (request, reply) => {
    const result = db.prepare("DELETE FROM activation_scripts WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "语料不存在" });
  });
  // Target item shape (no `id`): device_code, name, recruiter_id,
  // activation_enabled (0/1), daily_limit, hourly_limit, burst10_limit,
  // today_sent, dify_url — all numbers where a flag is expected.
  app.get("/api/v1/activation/devices", async (request) => {
    const rows = db.prepare("SELECT * FROM activation_devices ORDER BY id").all() as Array<Record<string, unknown>>;
    const items = rows.map((row) => {
      const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
      return {
        device_code: String(data.device_code ?? ""),
        name: String(data.name ?? row.device_name ?? ""),
        recruiter_id: String(data.recruiter_id ?? ""),
        activation_enabled: row.status === "enabled",
        daily_limit: Number(data.daily_limit ?? 20),
        hourly_limit: Number(data.hourly_limit ?? 10),
        burst10_limit: Number(data.burst10_limit ?? 3),
        today_sent: Number(data.today_sent ?? 0),
        dify_url: String(data.dify_url ?? ""),
      };
    });
    const scope = deviceScope(request.auth!);
    return { items: items.filter((item) => canAccessDevice(scope, String(item.device_code ?? ""))) };
  });
  app.get<{ Params: { id: string } }>("/api/v1/activation/customers/:id", async (request, reply) => {
    const customerId = Number(request.params.id);
    const scope = deviceConstraint(deviceScope(request.auth!), "device_code");
    const records = db.prepare(`SELECT * FROM activation_records WHERE customer_id=?${scope.sql} ORDER BY id DESC`).all(customerId, ...scope.values);
    if (!records.length) return reply.code(404).send({ detail: "客户不存在或无权访问" });
    return { customer_id: customerId, summary: "", records };
  });
  // Regenerating a summary needs at least one activation record to summarise;
  // the target answers 404 "客户不存在或无权访问" otherwise.
  app.post<{ Params: { id: string } }>("/api/v1/activation/customers/:id/regenerate-summary", async (request, reply) => {
    const customerId = Number(request.params.id);
    const scope = deviceConstraint(deviceScope(request.auth!), "device_code");
    const records = db.prepare(`SELECT * FROM activation_records WHERE customer_id=?${scope.sql} ORDER BY id DESC`).all(customerId, ...scope.values);
    if (!records.length) return reply.code(404).send({ detail: "客户不存在或无权访问" });
    return { success: true, customer_id: customerId, summary: "" };
  });
}
