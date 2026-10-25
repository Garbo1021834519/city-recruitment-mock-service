import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { serializeAgentDevice, serializeCandidate, serializeMetrics, serializeStatusDashboard } from "../../shared/response-serializers.js";
import { canAccessDevice, deviceConstraint, getUserScope } from "../../auth/user-scopes.js";

export async function registerAgentRoutes(app: FastifyInstance, db: DatabaseSync) {
  const canAccessDeviceForRequest = (request: import("fastify").FastifyRequest, deviceCode: string) =>
    !request.auth || canAccessDevice(getUserScope(db, request.auth), deviceCode);
  // Target envelope has no `total`; each item carries the Dify config fields:
  // id, device_code, name, dify_url, dify_key, recruiter_id, status, online,
  // mode, config, last_online, created_at, last_offline, queue_depth, queue_stale
  app.get<{ Querystring: { my?: string } }>("/api/v1/agent/devices", async (request) => {
    const rows = db.prepare("SELECT * FROM agent_devices ORDER BY id DESC").all() as Array<Record<string, unknown>>;
    const scope = getUserScope(db, request.auth!);
    return { items: rows.map(serializeAgentDevice).filter((row) => canAccessDevice(scope, String(row.device_code ?? ""))) };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/devices", async (request, reply) => { if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required to create devices" }); return db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,?,?) RETURNING *").get(String(request.body?.device_name ?? request.body?.name ?? "本地设备"), String(request.body?.status ?? "enabled"), JSON.stringify(request.body ?? {})); });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/agent/devices/:id", async (request, reply) => { const id = Number(request.params.id); const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined; const data = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {}; if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return reply.code(404).send({ detail: "设备不存在" }); const result = db.prepare("UPDATE agent_devices SET device_name=COALESCE(?,device_name),status=COALESCE(?,status),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(typeof request.body?.device_name === "string" ? request.body.device_name : null, typeof request.body?.status === "string" ? request.body.status : null, JSON.stringify({ ...data, ...(request.body ?? {}) }), id); return result.changes ? db.prepare("SELECT * FROM agent_devices WHERE id=?").get(id) : reply.code(404).send({ detail: "设备不存在" }); });
  // The target 404s on a missing row; returning {success:false} with 200 is a
  // parity bug (verified: DELETE /agent/devices/999999 -> 404 "Device not found").
  app.delete<{ Params: { id: string } }>("/api/v1/agent/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined;
    const data = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return reply.code(404).send({ detail: "Device not found" });
    const result = db.prepare("DELETE FROM agent_devices WHERE id=?").run(id);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Device not found" });
  });
  app.get<{ Querystring: { device_code?: string } }>("/api/v1/agent/conversations", async (request, reply) => { const deviceCode = request.query.device_code ?? ""; if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const rows = db.prepare("SELECT * FROM agent_conversations WHERE device_code=? ORDER BY updated_at DESC").all(deviceCode); return { items: rows, total_unread: (rows as Array<Record<string, unknown>>).reduce((sum, row) => sum + Number(row.unread ?? 0), 0) }; });
  app.get<{ Querystring: { device_code?: string; customer_id?: string; after_id?: string } }>("/api/v1/agent/messages", async (request, reply) => { const deviceCode = request.query.device_code ?? ""; if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); return { items: db.prepare("SELECT * FROM agent_messages WHERE device_code=? AND customer_id=? AND id>? ORDER BY id").all(deviceCode, Number(request.query.customer_id ?? 0), Number(request.query.after_id ?? 0)), takeover: false }; });
  app.post<{ Body: { device_code?: string; customer_id?: number; takeover?: boolean } }>("/api/v1/agent/takeover", async (request, reply) => { const deviceCode = request.body?.device_code ?? ""; if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const result = db.prepare("UPDATE agent_conversations SET takeover=? WHERE device_code=? AND customer_id=?").run(request.body?.takeover ? 1 : 0, deviceCode, request.body?.customer_id ?? 0); return result.changes ? { success: true } : reply.code(404).send({ detail: "Conversation not found" }); });
  app.post<{ Body: { device_code?: string; customer_id?: number; content?: string } }>("/api/v1/agent/manual-reply", async (request, reply) => { const deviceCode = request.body?.device_code ?? ""; if (!canAccessDevice(getUserScope(db, request.auth!), deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const customerId = request.body?.customer_id ?? 0; if (!db.prepare("SELECT id FROM agent_conversations WHERE device_code=? AND customer_id=?").get(deviceCode, customerId)) return reply.code(404).send({ detail: "Conversation not found" }); const result = db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content) VALUES (?,?,?,?)").run(deviceCode, customerId, "outbound", request.body?.content ?? ""); return db.prepare("SELECT * FROM agent_messages WHERE id=?").get(Number(result.lastInsertRowid)); });
  app.get<{ Querystring: { event_type?: string; page?: string; page_size?: string } }>("/api/v1/agent/candidates", async (request) => {
    const page = Math.max(1, Number(request.query.page) || 1), pageSize = Math.min(1000, Math.max(1, Number(request.query.page_size) || 50));
    const scopeFilter = deviceConstraint(getUserScope(db, request.auth!), "device_code");
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (request.query.event_type) { conditions.push("event_type=?"); params.push(request.query.event_type); }
    if (scopeFilter.sql) conditions.push(scopeFilter.sql.replace(/^ AND /, ""));
    params.push(...scopeFilter.values);
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    // Target item has no data_json/updated_at, and does carry wechat_id
    // (stored inside data_json locally since the column doesn't exist).
    const COLUMNS = "id,device_code,customer_id,nickname,event_type,event_at,name,phone,interview_date,interview_time,factory_name,city,district,status,remind_count,disqualified_reason,created_at,data_json";
    const rows = db.prepare(`SELECT ${COLUMNS} FROM candidate_events${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    const items = rows.map(serializeCandidate);
    const total = (db.prepare(`SELECT COUNT(*) count FROM candidate_events${where}`).get(...params) as { count: number }).count;
    return { items, total };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/candidates", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.customer_id !== "string") return reply.code(422).send({ detail: "customer_id 必填" });
    if (!canAccessDevice(getUserScope(db, request.auth!), String(body.device_code ?? ""))) return reply.code(403).send({ detail: "Device scope required" });
    const result = db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type,name,city,status,data_json) VALUES (?,?,?,?,?,?,?,?)").run(String(body.device_code ?? ""), body.customer_id, String(body.nickname ?? ""), String(body.event_type ?? "invited"), String(body.name ?? ""), String(body.city ?? ""), String(body.status ?? body.event_type ?? "invited"), JSON.stringify(body));
    return db.prepare("SELECT * FROM candidate_events WHERE id=?").get(Number(result.lastInsertRowid));
  });
  app.post<{ Params: { id: string }; Body: { status?: string } }>("/api/v1/agent/candidates/:id/mark", async (request, reply) => {
    const candidate = db.prepare("SELECT device_code FROM candidate_events WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!candidate || !canAccessDevice(getUserScope(db, request.auth!), candidate.device_code)) return reply.code(404).send({ detail: "候选人不存在" });
    const result = db.prepare("UPDATE candidate_events SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(request.body?.status ?? "marked", Number(request.params.id));
    return result.changes ? db.prepare("SELECT * FROM candidate_events WHERE id=?").get(Number(request.params.id)) : reply.code(404).send({ detail: "候选人不存在" });
  });
  // Target item shape: id, account, customer_id, nickname, device_code, status,
  // created_at — updated_at is not exposed.
  app.get("/api/v1/agent/old-friends", async (request) => {
    const scopeFilter = deviceConstraint(getUserScope(db, request.auth!), "device_code");
    const rows = db.prepare(`SELECT id,account,customer_id,nickname,device_code,status,created_at FROM old_friend_records WHERE 1=1${scopeFilter.sql} ORDER BY id DESC`).all(...scopeFilter.values);
    return { items: rows, total: rows.length };
  });
  app.get("/api/v1/agent/old-friends/accounts", async (request) => { const scopeFilter = deviceConstraint(db ? getUserScope(db, request.auth!) : { isAdmin: true, deviceCodes: [], recruiterIds: [], recruiterDbIds: [], cityIds: [], userId: 0 }, "device_code"); return { items: [...new Set((db.prepare(`SELECT account FROM old_friend_records WHERE account<>''${scopeFilter.sql} ORDER BY account`).all(...scopeFilter.values) as Array<{ account: string }>).map((row) => row.account))] }; });
  // Target rejects a mark without both identifiers as 400, not 500/200.
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/old-friends/mark", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.device_code || body.customer_id === undefined || body.customer_id === null) {
      return reply.code(400).send({ detail: "device_code and customer_id are required" });
    }
    if (!canAccessDevice(getUserScope(db, request.auth!), String(body.device_code))) return reply.code(403).send({ detail: "Device scope required" });
    const result = db.prepare("INSERT INTO old_friend_records(account,customer_id,nickname,device_code,status) VALUES (?,?,?,?,?)").run(String(body.account ?? ""), String(body.customer_id), String(body.nickname ?? ""), String(body.device_code), String(body.status ?? "released"));
    return db.prepare("SELECT * FROM old_friend_records WHERE id=?").get(Number(result.lastInsertRowid));
  });
  app.put<{ Params: { id: string } }>("/api/v1/agent/old-friends/:id/release", async (request, reply) => {
    const friend = db.prepare("SELECT device_code FROM old_friend_records WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!friend || !canAccessDevice(getUserScope(db, request.auth!), friend.device_code)) return reply.code(404).send({ detail: "Old friend not found" });
    const result = db.prepare("UPDATE old_friend_records SET status='released',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Old friend not found" });
  });
  app.put<{ Params: { id: string } }>("/api/v1/agent/old-friends/:id/unrelease", async (request, reply) => {
    const friend = db.prepare("SELECT device_code FROM old_friend_records WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!friend || !canAccessDevice(getUserScope(db, request.auth!), friend.device_code)) return reply.code(404).send({ detail: "Old friend not found" });
    const result = db.prepare("UPDATE old_friend_records SET status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Old friend not found" });
  });
  app.delete<{ Params: { id: string } }>("/api/v1/agent/old-friends/:id", async (request, reply) => {
    const friend = db.prepare("SELECT device_code FROM old_friend_records WHERE id=?").get(Number(request.params.id)) as { device_code: string } | undefined;
    if (!friend || !canAccessDevice(getUserScope(db, request.auth!), friend.device_code)) return reply.code(404).send({ detail: "Old friend not found" });
    const result = db.prepare("DELETE FROM old_friend_records WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Old friend not found" });
  });
  app.get("/api/v1/agent/status/dashboard", async (request) => {
    const scope = getUserScope(db, request.auth!);
    const deviceFilter = (column: string) => deviceConstraint(scope, column);
    const agentDeviceFilter = scope.isAdmin ? { sql: "", values: [] as string[] } : scope.deviceCodes.length
      ? { sql: ` AND json_extract(data_json,'$.device_code') IN (${scope.deviceCodes.map(() => "?").join(",")})`, values: scope.deviceCodes }
      : { sql: " AND 1=0", values: [] as string[] };
    const devices = (db.prepare(`SELECT COUNT(*) AS total FROM agent_devices WHERE 1=1${agentDeviceFilter.sql}`).get(...agentDeviceFilter.values) as { total: number }).total;
    const messagesScope = deviceFilter("device_code");
    const messages = (db.prepare(`SELECT COUNT(*) AS total FROM agent_messages WHERE 1=1${messagesScope.sql}`).get(...messagesScope.values) as { total: number }).total;
    const pendingScope = deviceFilter("device_code");
    const pending = (db.prepare(`SELECT COUNT(*) AS total FROM agent_conversations WHERE state='pending_invite'${pendingScope.sql}`).get(...pendingScope.values) as { total: number }).total;
    const failedScope = deviceFilter("device_code");
    const failed = (db.prepare(`SELECT COUNT(*) AS total FROM agent_messages WHERE status='failed'${failedScope.sql}`).get(...failedScope.values) as { total: number }).total;
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    return serializeStatusDashboard({ devices: { total: devices, active_today: 0 }, messages: { total: messages, hourly }, queue: { pending }, errors: { failed_today: failed, ai_abnormal: 0 }, state_distribution: {}, device_ranking: [], dify_health: [], degraded: [], daily_trend: [] });
  });
  // device_code is a required query parameter on the target (422 when absent),
  // but its value is not authenticated: any string reaches the DB lookup.
  const deviceQuerySchema = { querystring: { type: "object", required: ["device_code"], properties: { device_code: { type: "string" } } } } as const;
  app.put<{ Params: { id: string }; Querystring: { device_code: string } }>("/api/v1/agent/conversations/:id/restart", { schema: deviceQuerySchema }, async (request, reply) => { const deviceCode = request.query.device_code; if (!canAccessDeviceForRequest(request, deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const result = db.prepare("UPDATE agent_conversations SET state='active',recruit_status='none',updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND device_code=?").run(Number(request.params.id), deviceCode); return result.changes ? { success: true } : reply.code(404).send({ detail: "Conversation not found" }); });
  app.put<{ Params: { id: string }; Querystring: { device_code: string } }>("/api/v1/agent/conversations/:id/reset-disqualified", { schema: deviceQuerySchema }, async (request, reply) => { const deviceCode = request.query.device_code; if (!canAccessDeviceForRequest(request, deviceCode)) return reply.code(403).send({ detail: "Device scope required" }); const result = db.prepare("UPDATE agent_conversations SET state='active',recruit_status='none',updated_at=CURRENT_TIMESTAMP WHERE customer_id=? AND device_code=?").run(Number(request.params.id), deviceCode); return result.changes ? { success: true } : reply.code(404).send({ detail: "Conversation not found" }); });
  // Target 404s "Device not found" when the device row is missing.
  app.post<{ Params: { id: string } }>("/api/v1/agent/device/:id/clear-unread", async (request, reply) => {
    const deviceId = Number(request.params.id);
    const device = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(deviceId) as { data_json: string } | undefined;
    if (!device) return reply.code(404).send({ detail: "Device not found" });
    const deviceData = JSON.parse(device.data_json || "{}") as Record<string, unknown>;
    if (!canAccessDevice(getUserScope(db, request.auth!), String(deviceData.device_code ?? ""))) return reply.code(404).send({ detail: "Device not found" });
    db.prepare("UPDATE agent_conversations SET unread=0,updated_at=CURRENT_TIMESTAMP WHERE device_code=(SELECT device_code FROM agent_devices WHERE id=?)").run(deviceId);
    return { success: true };
  });
  // Target envelope is exactly {items: []} — no total/page/page_size.
  app.get("/api/v1/agent/reminder-tasks", async () => ({ items: [] }));
  // Target shape: {ok: boolean, message: string} — a status envelope, not the
  // stored workflow blob itself.
  app.get<{ Params: { id: string } }>("/api/v1/agent/device/:id/workflow", async (request) => {
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(Number(request.params.id)) as { data_json: string } | undefined;
    const data = row && typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return { ok: false, message: "设备不存在" };
    const uploaded = Boolean(data.workflow_file || data.workflow);
    return { ok: uploaded, message: uploaded ? "" : "暂未上传工作流文件" };
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/agent/device/:id/workflow", async (request, reply) => { const id = Number(request.params.id); const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined; const existing = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {}; if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(existing.device_code ?? ""))) return reply.code(404).send({ detail: "设备不存在" }); const result = db.prepare("UPDATE agent_devices SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify({ ...existing, ...(request.body ?? {}) }), id); return result.changes ? request.body ?? {} : reply.code(404).send({ detail: "设备不存在" }); });
  app.delete<{ Params: { id: string } }>("/api/v1/agent/device/:id/workflow", async (request, reply) => {
    const id = Number(request.params.id);
    const row = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(id) as { data_json: string } | undefined;
    const data = row ? JSON.parse(row.data_json || "{}") as Record<string, unknown> : {};
    if (!row || !canAccessDevice(getUserScope(db, request.auth!), String(data.device_code ?? ""))) return reply.code(404).send({ detail: "Device not found" });
    const result = db.prepare("UPDATE agent_devices SET data_json='{}',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Device not found" });
  });
  // Target shape: {start_date, end_date, items} — a date window, not counters.
  app.get("/api/v1/agent/report/metrics", async () => {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const start = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    return serializeMetrics({ start_date: start, end_date: end, items: [] });
  });
}
