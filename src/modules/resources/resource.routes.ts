import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";
import { serializeAccountSummary, serializeEvaluationOverview, serializeRecruiter } from "../../shared/response-serializers.js";
import { canAccessCity, canAccessDevice, canAccessRecruiter, getUserScope, type UserScope } from "../../auth/user-scopes.js";
import { rolePreHandler } from "../../auth/rbac.js";

type Resource = { table: string; name: string; fields: string[]; scope: "city" | "recruiter" | "device" | "admin" };
const resources: Resource[] = [
  { table: "knowledge_items", name: "knowledge", fields: ["title", "content", "status"], scope: "recruiter" },
  { table: "unknown_questions", name: "unknown-questions", fields: ["question", "status"], scope: "recruiter" },
  { table: "holiday_schedules", name: "holiday-schedules", fields: ["city_id", "date", "kind"], scope: "city" },
  { table: "recruiters", name: "recruiters", fields: ["username", "city_id", "status"], scope: "recruiter" },
  { table: "agent_rules", name: "agent/rules", fields: ["rule_name", "status"], scope: "recruiter" },
  { table: "agent_evaluations", name: "agent/evaluations", fields: ["evaluation_name", "status"], scope: "device" },
  { table: "activation_strategies", name: "activation/strategy-resources", fields: ["strategy_name", "status"], scope: "admin" },
  { table: "activation_devices", name: "activation/device-resources", fields: ["device_name", "status"], scope: "admin" },
];

function rowData(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.data_json !== "string") return {};
  try {
    const data: unknown = JSON.parse(row.data_json);
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  } catch { return {}; }
}

function canAccessResource(resource: Resource, row: Record<string, unknown>, scope: UserScope): boolean {
  if (scope.isAdmin) return true;
  const data = rowData(row);
  switch (resource.scope) {
    case "city": return canAccessCity(scope, Number(row.city_id));
    case "recruiter": return canAccessRecruiter(scope, String(data.recruiter_id ?? row.recruiter_id ?? row.username ?? ""));
    case "device": return canAccessDevice(scope, String(data.device_code ?? row.device_code ?? ""));
    case "admin": return false;
  }
}

function toOutput(row: Record<string, unknown>, resource?: Resource, db?: DatabaseSync) {
  const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
  const { data_json: _data, ...base } = row;
  const result = { ...base, ...data } as Record<string, unknown>;
  // Target projects knowledge items to exactly these seven fields; title/content/
  // status/created_at are local storage details and must not leak out.
  if (resource?.name === "knowledge") {
    return {
      id: result.id,
      question: result.question ?? result.title ?? "",
      keywords: Array.isArray(result.keywords) ? result.keywords : [],
      is_active: Boolean(result.is_active ?? result.status === "enabled"),
      sort_order: Number(result.sort_order ?? 0),
      recruiter_id: String(result.recruiter_id ?? ""),
      updated_at: result.updated_at,
    };
  }
  if (resource?.name === "unknown-questions") {
    result.status = row.status;
    delete result.converted_knowledge_id;
    delete result.converted_at;
  }
  if (resource?.name === "activation/scripts") { result.content = result.content ?? result.script_name; result.category = result.category ?? data.category ?? "寒暄召回"; result.is_active = result.is_active ?? result.status === "enabled"; result.used_count = result.used_count ?? 0; }
  if (resource?.name === "recruiters") {
    const recruiterId = Number(result.id);
    const cities = db ? db.prepare("SELECT rc.city_id,c.city_name,rc.is_enabled,rc.sort_order FROM recruiter_cities rc JOIN cities c ON c.id=rc.city_id WHERE rc.recruiter_id=? AND rc.is_service=0 ORDER BY rc.sort_order,c.city_name").all(recruiterId) as Array<Record<string, unknown>> : [];
    return serializeRecruiter(row, cities);
  }
  return result;
}

function value(body: Record<string, unknown>, field: string): string | number {
  const raw = body[field];
  return typeof raw === "number" || typeof raw === "string" ? raw : "";
}

/**
 * The target's public field names differ from the local column names.
 * knowledge: {question, answer} -> (title, content)
 * recruiters: {recruiter_id, name} -> (username)
 * Without this mapping the NOT NULL columns receive nothing and SQLite 500s.
 */
const FIELD_ALIASES: Record<string, Record<string, string[]>> = {
  knowledge: { title: ["question"], content: ["answer"] },
  recruiters: { username: ["recruiter_id", "name"] },
};

function resolveField(resourceName: string, body: Record<string, unknown>, column: string): unknown {
  if (body[column] !== undefined && body[column] !== null) return body[column];
  for (const alias of FIELD_ALIASES[resourceName]?.[column] ?? []) {
    if (typeof body[alias] === "string") return body[alias];
  }
  return undefined;
}

function list(db: DatabaseSync, resource: Resource, query: Record<string, unknown>, scope: UserScope) {
  const { page, pageSize, offset } = parsePagination(query);
  const rows = (db.prepare(`SELECT * FROM ${resource.table} ORDER BY id DESC`).all() as Array<Record<string, unknown>>).filter((row) => canAccessResource(resource, row, scope));
  // Target list envelope is exactly {items, total} for these resources.
  return { items: rows.slice(offset, offset + pageSize).map((row) => toOutput(row, resource, db)), total: rows.length };
}

export async function registerResourceRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.post<{ Params: { id: string }; Body: { question: string; answer: string; keywords?: string[]; sort_order?: number; recruiter_id?: string } }>(
    "/api/v1/unknown-questions/:id/convert",
    async (request, reply) => {
      const answer = request.body.answer;
      if (typeof answer !== "string" || answer.trim() === "") {
        return reply.code(422).send({ detail: "Answer cannot be empty" });
      }

      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const id = Number(request.params.id);
        const unknown = db.prepare("SELECT * FROM unknown_questions WHERE id=?").get(id) as Record<string, unknown> | undefined;
        if (!unknown) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return reply.code(404).send({ detail: "Unknown question not found" });
        }
        const scope = getUserScope(db, request.auth!);
        const unknownResource = resources.find((resource) => resource.name === "unknown-questions")!;
        if (!canAccessResource(unknownResource, unknown, scope)) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return reply.code(404).send({ detail: "Unknown question not found" });
        }
        if (unknown.status !== "pending" || unknown.converted_knowledge_id !== null) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return reply.code(409).send({ detail: "Unknown question already converted or is not pending" });
        }

        const question = request.body.question.trim() || String(unknown.question);
        const keywords = Array.isArray(request.body.keywords)
          ? request.body.keywords.filter((keyword): keyword is string => typeof keyword === "string").map((keyword) => keyword.trim()).filter(Boolean)
          : [];
        const sourceData = typeof unknown.data_json === "string" ? JSON.parse(unknown.data_json) as Record<string, unknown> : {};
        const sortOrder = Number(request.body.sort_order ?? sourceData.sort_order ?? 0) || 0;
        const recruiterId = String(request.body.recruiter_id ?? sourceData.recruiter_id ?? "");
        const data = { question, keywords, is_active: true, sort_order: sortOrder, recruiter_id: recruiterId };
        const knowledgeResource = resources.find((resource) => resource.name === "knowledge")!;
        if (!canAccessResource(knowledgeResource, { data_json: JSON.stringify(data) }, scope)) {
          db.exec("ROLLBACK");
          transactionOpen = false;
          return reply.code(403).send({ detail: "Resource scope required" });
        }
        const knowledge = db.prepare("INSERT INTO knowledge_items(title,content,status,data_json) VALUES (?,?,?,?) RETURNING *")
          .get(question, answer, "enabled", JSON.stringify(data)) as Record<string, unknown>;
        const transition = db.prepare("UPDATE unknown_questions SET status='resolved',converted_knowledge_id=?,converted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND converted_knowledge_id IS NULL")
          .run(Number(knowledge.id), id);
        if (transition.changes !== 1) throw new Error("Unknown question state changed during conversion");
        db.exec("COMMIT");
        transactionOpen = false;
        return toOutput(knowledge, resources.find((resource) => resource.name === "knowledge"));
      } catch {
        if (transactionOpen) db.exec("ROLLBACK");
        return reply.code(500).send({ detail: "Knowledge conversion failed" });
      }
    },
  );

  for (const resource of resources) {
    const base = `/api/v1/${resource.name}`;
    app.get<{ Querystring: Record<string, unknown> }>(base, async (request) => {
      const result = list(db, resource, request.query, getUserScope(db, request.auth!));
      if (resource.name === "activation/scripts") {
        const active = (db.prepare("SELECT COUNT(*) count FROM activation_scripts WHERE status='enabled'").get() as { count: number }).count;
        const categories = [...new Set(result.items.map((item) => String((item as Record<string, unknown>).category ?? "")))].filter(Boolean);
        return { ...result, active_total: active, categories };
      }
      return result;
    });
    app.get<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => { const row = db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(Number(request.params.id)) as Record<string, unknown> | undefined; return row && canAccessResource(resource, row, getUserScope(db, request.auth!)) ? toOutput(row, resource, db) : reply.code(404).send({ detail: "记录不存在" }); });
    app.post<{ Body: Record<string, unknown> }>(base, async (request, reply) => {
      const body = request.body ?? {};
      const scope = getUserScope(db, request.auth!);
      const proposedRow = {
        ...body,
        username: resolveField(resource.name, body, "username"),
        data_json: JSON.stringify(body),
      };
      if (!canAccessResource(resource, proposedRow, scope)) return reply.code(403).send({ detail: "Resource scope required" });
      const columns = resource.fields.filter((field) => field !== "status" || body[field] !== undefined);
      // Absent values must be SQL NULL, not "": an empty string for a foreign
      // key (recruiters.city_id) fails the constraint with a 500. Fields whose
      // public name differs from the column go through resolveField.
      const values = columns.map((column) => {
        const resolved = resolveField(resource.name, body, column);
        if (resolved === undefined) return null;
        return typeof resolved === "number" || typeof resolved === "string" ? resolved : "";
      });
      const placeholders = columns.map(() => "?").join(",");
      const result = db.prepare(`INSERT INTO ${resource.table}(${columns.join(",")},data_json) VALUES (${placeholders},?)`).run(...values, JSON.stringify(body));
      return toOutput(db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(Number(result.lastInsertRowid)) as Record<string, unknown>, resource, db);
    });
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(`${base}/:id`, async (request, reply) => {
      const body = request.body ?? {};
      const id = Number(request.params.id);
      const current = db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      const scope = getUserScope(db, request.auth!);
      if (!current || !canAccessResource(resource, current, scope)) return reply.code(404).send({ detail: "记录不存在" });
      const nextData = { ...rowData(current), ...body };
      const nextRow = { ...current, ...body, data_json: JSON.stringify(nextData) };
      if (!canAccessResource(resource, nextRow, scope)) return reply.code(403).send({ detail: "Resource scope required" });
      const assignments = resource.fields.map((field) => `${field}=COALESCE(?,${field})`).join(",");
      const values = resource.fields.map((field) => body[field] === undefined ? null : value(body, field));
      const result = db.prepare(`UPDATE ${resource.table} SET ${assignments},data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values, JSON.stringify(nextData), id);
      return result.changes ? toOutput(db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(id) as Record<string, unknown>, resource, db) : reply.code(404).send({ detail: "记录不存在" });
    });
    app.delete<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => { const id = Number(request.params.id); const row = db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(id) as Record<string, unknown> | undefined; if (!row || !canAccessResource(resource, row, getUserScope(db, request.auth!))) return reply.code(404).send({ detail: "记录不存在" }); const result = db.prepare(`DELETE FROM ${resource.table} WHERE id=?`).run(id); return result.changes ? { success: true } : reply.code(404).send({ detail: "记录不存在" }); });
  }

  // Target shape is a fixed four-key object: company_name, dedup_llm_api_key,
  // dedup_llm_model (strings) and requirements (object).
  app.get("/api/v1/settings", async () => {
    const rows = db.prepare("SELECT key,value_json FROM settings ORDER BY key").all() as Array<{ key: string; value_json: string }>;
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
    return {
      company_name: String(stored.company_name ?? ""),
      dedup_llm_api_key: String(stored.dedup_llm_api_key ?? ""),
      dedup_llm_model: String(stored.dedup_llm_model ?? ""),
      // Target types: age_range is a label string ("18-35岁"), age_limit is an
      // object ({min, max}). Swapping them is a shape divergence.
      requirements: (() => {
        const storedReq = stored.requirements && typeof stored.requirements === "object" ? stored.requirements as Record<string, unknown> : {};
        return {
          age_range: typeof storedReq.age_range === "string" ? storedReq.age_range : "",
          age_limit: storedReq.age_limit && typeof storedReq.age_limit === "object" ? storedReq.age_limit : { min: 0, max: 0 },
        };
      })(),
    };
  });
  // The target echoes the same four-key settings object that GET returns.
  app.put<{ Body: Record<string, unknown> }>("/api/v1/settings", { preHandler: rolePreHandler("admin") }, async (request) => {
    for (const [key, value] of Object.entries(request.body ?? {})) db.prepare("INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(key, JSON.stringify(value));
    const rows = db.prepare("SELECT key,value_json FROM settings").all() as Array<{ key: string; value_json: string }>;
    const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
    const storedReq = stored.requirements && typeof stored.requirements === "object" ? stored.requirements as Record<string, unknown> : {};
    return {
      company_name: String(stored.company_name ?? ""),
      dedup_llm_api_key: String(stored.dedup_llm_api_key ?? ""),
      dedup_llm_model: String(stored.dedup_llm_model ?? ""),
      requirements: {
        age_range: typeof storedReq.age_range === "string" ? storedReq.age_range : "",
        age_limit: storedReq.age_limit && typeof storedReq.age_limit === "object" ? storedReq.age_limit : { min: 0, max: 0 },
      },
    };
  });
  // Target includes is_default alongside the base URL.
  app.get("/api/v1/settings/agent", async () => ({ agent_base_url: "", is_default: true }));
  app.put<{ Body: { agent_base_url?: string } }>("/api/v1/settings/agent", { preHandler: rolePreHandler("admin") }, async (request, reply) => {
    const url = request.body?.agent_base_url;
    if (typeof url !== "string" || url.trim() === "") return reply.code(400).send({ detail: "agent_base_url 不能为空" });
    db.prepare("INSERT INTO settings(key,value_json) VALUES ('agent_base_url',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(url));
    return { agent_base_url: url };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/settings/sync", { preHandler: rolePreHandler("admin") }, async (request) => ({ success: true, synced: Object.keys(request.body ?? {}) }));
  app.get("/api/v1/agent/reminder-config", async () => {
    const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : { id: 0, recruiter_id: "global", enabled: false, mode: "advance", advance_hours: 2, fixed_time: "09:00", script: "" };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/reminder-config", async (request, reply) => { if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" }); const body = request.body ?? {}; db.prepare("INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('reminder','global',?) ON CONFLICT(kind,recruiter_id) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify({ id: 0, recruiter_id: "global", enabled: Boolean(body.enabled), mode: body.mode ?? "advance", advance_hours: Number(body.advance_hours ?? 2), fixed_time: body.fixed_time ?? "09:00", script: body.script ?? "" })); return JSON.parse(String((db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string }).value_json)); });
  app.get("/api/v1/agent/followup-config", async () => { const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='followup' AND recruiter_id='global'").get() as { value_json: string } | undefined; return row ? JSON.parse(row.value_json) : { id: 0, recruiter_id: "global", enabled: false, interval_seconds: 300, max_count: 3, scripts: [] }; });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/followup-config", async (request, reply) => { if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" }); const body = request.body ?? {}; const value = { id: 0, recruiter_id: "global", enabled: Boolean(body.enabled), interval_seconds: Number(body.interval_seconds ?? 300), max_count: Number(body.max_count ?? 3), scripts: Array.isArray(body.scripts) ? body.scripts : [] }; db.prepare("INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('followup','global',?) ON CONFLICT(kind,recruiter_id) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(value)); return value; });
  // Target shape: {days: number, items: array} — no per-status counters.
  app.get<{ Querystring: { days?: string } }>("/api/v1/agent/evaluation/overview", async (request) => serializeEvaluationOverview({ days: Number(request.query.days ?? 7), items: [] }));
  app.get<{ Querystring: { device_code?: string; eval_date?: string } }>("/api/v1/agent/evaluation/detail", async (request) => ({ device_code: request.query.device_code ?? "", eval_date: request.query.eval_date ?? "", items: [] }));
  // Running an evaluation across devices is admin-only on the target.
  app.post<{ Querystring: { device_code?: string; eval_date?: string } }>("/api/v1/agent/evaluation/run", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required to evaluate all devices" });
    return { success: true, device_code: request.query.device_code ?? "", eval_date: request.query.eval_date ?? new Date().toISOString().slice(0, 10), total: 0, invited: 0, failed: 0 };
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/agent/report/account-summary", async (request) => serializeAccountSummary({ prefix: request.query.prefix ?? "", date_range: { start: request.query.start_date ?? "", end: request.query.end_date ?? "" }, total: {}, accounts: [], daily_trend: [] }));
  app.post<{ Body: { ids?: number[]; status?: string; is_active?: boolean } }>("/api/v1/knowledge/batch/update", async (request) => { const ids = Array.isArray(request.body?.ids) ? request.body.ids : []; const scope = getUserScope(db, request.auth!); const resource = resources.find((item) => item.name === "knowledge")!; let updated = 0; for (const id of ids) { const row = db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(Number(id)) as Record<string, unknown> | undefined; if (!row || !canAccessResource(resource, row, scope)) continue; const result = db.prepare("UPDATE knowledge_items SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(request.body?.status ?? (request.body?.is_active === false ? "disabled" : "enabled"), Number(id)); updated += Number(result.changes); } return { success: true, updated }; });
  app.post<{ Body: { ids?: number[] } }>("/api/v1/knowledge/batch/delete", async (request) => { const ids = Array.isArray(request.body?.ids) ? request.body.ids : []; const scope = getUserScope(db, request.auth!); const resource = resources.find((item) => item.name === "knowledge")!; let deleted = 0; for (const id of ids) { const row = db.prepare("SELECT * FROM knowledge_items WHERE id=?").get(Number(id)) as Record<string, unknown> | undefined; if (!row || !canAccessResource(resource, row, scope)) continue; deleted += Number(db.prepare("DELETE FROM knowledge_items WHERE id=?").run(Number(id)).changes); } return { success: true, deleted }; });
  // Target shape: {cities: array, unlimited: boolean} — no items envelope.
  // Target item shape: {city_name, interview_site_name}.
  app.get("/api/v1/holiday-schedules/my-cities", async (request) => {
    const scope = getUserScope(db, request.auth!);
    const rows = (db.prepare("SELECT id,city_name,data_json FROM cities ORDER BY city_name").all() as Array<{ id: number; city_name: string; data_json: string }>).filter((row) => canAccessCity(scope, row.id));
    return {
      cities: rows.map((row) => {
        const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
        return { city_name: row.city_name, interview_site_name: String(data.interview_site_name ?? "") };
      }),
      unlimited: scope.isAdmin,
    };
  });
}
