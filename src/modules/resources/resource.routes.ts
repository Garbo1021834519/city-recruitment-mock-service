import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";

type Resource = { table: string; name: string; fields: string[] };
const resources: Resource[] = [
  { table: "knowledge_items", name: "knowledge", fields: ["title", "content", "status"] },
  { table: "unknown_questions", name: "unknown-questions", fields: ["question", "status"] },
  { table: "holiday_schedules", name: "holiday-schedules", fields: ["city_id", "date", "kind"] },
  { table: "recruiters", name: "recruiters", fields: ["username", "city_id", "status"] },
  { table: "agent_rules", name: "agent/rules", fields: ["rule_name", "status"] },
  { table: "agent_evaluations", name: "agent/evaluations", fields: ["evaluation_name", "status"] },
  { table: "activation_strategies", name: "activation/strategy-resources", fields: ["strategy_name", "status"] },
  { table: "activation_devices", name: "activation/device-resources", fields: ["device_name", "status"] },
];

function toOutput(row: Record<string, unknown>, resource?: Resource) {
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
  if (resource?.name === "activation/scripts") { result.content = result.content ?? result.script_name; result.category = result.category ?? data.category ?? "寒暄召回"; result.is_active = result.is_active ?? result.status === "enabled"; result.used_count = result.used_count ?? 0; }
  if (resource?.name === "recruiters") { result.recruiter_id = result.recruiter_id ?? result.username; result.name = result.name ?? result.username; result.recruiter_type = result.recruiter_type ?? "service"; result.is_active = result.is_active ?? result.status === "enabled"; result.city_count = result.city_count ?? 0; result.cities = result.cities ?? []; result.password_set = false; }
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

function list(db: DatabaseSync, resource: Resource, query: Record<string, unknown>) {
  const { page, pageSize, offset } = parsePagination(query);
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${resource.table}`).get() as { count: number }).count;
  const rows = db.prepare(`SELECT * FROM ${resource.table} ORDER BY id DESC LIMIT ? OFFSET ?`).all(pageSize, offset) as Array<Record<string, unknown>>;
  // Target list envelope is exactly {items, total} for these resources.
  return { items: rows.map((row) => toOutput(row, resource)), total };
}

export async function registerResourceRoutes(app: FastifyInstance, db: DatabaseSync) {
  for (const resource of resources) {
    const base = `/api/v1/${resource.name}`;
    app.get<{ Querystring: Record<string, unknown> }>(base, async (request) => {
      const result = list(db, resource, request.query);
      if (resource.name === "activation/scripts") {
        const active = (db.prepare("SELECT COUNT(*) count FROM activation_scripts WHERE status='enabled'").get() as { count: number }).count;
        const categories = [...new Set(result.items.map((item) => String((item as Record<string, unknown>).category ?? "")))].filter(Boolean);
        return { ...result, active_total: active, categories };
      }
      return result;
    });
    app.get<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => { const row = db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(Number(request.params.id)) as Record<string, unknown> | undefined; return row ? toOutput(row, resource) : reply.code(404).send({ detail: "记录不存在" }); });
    app.post<{ Body: Record<string, unknown> }>(base, async (request) => {
      const body = request.body ?? {};
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
      return toOutput(db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(Number(result.lastInsertRowid)) as Record<string, unknown>, resource);
    });
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(`${base}/:id`, async (request, reply) => {
      const body = request.body ?? {};
      const assignments = resource.fields.map((field) => `${field}=COALESCE(?,${field})`).join(",");
      const values = resource.fields.map((field) => body[field] === undefined ? null : value(body, field));
      const result = db.prepare(`UPDATE ${resource.table} SET ${assignments},data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values, JSON.stringify(body), Number(request.params.id));
      return result.changes ? toOutput(db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(Number(request.params.id)) as Record<string, unknown>, resource) : reply.code(404).send({ detail: "记录不存在" });
    });
    app.delete<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => { const result = db.prepare(`DELETE FROM ${resource.table} WHERE id=?`).run(Number(request.params.id)); return result.changes ? { success: true } : reply.code(404).send({ detail: "记录不存在" }); });
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
  app.put<{ Body: Record<string, unknown> }>("/api/v1/settings", async (request) => {
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
  app.put<{ Body: { agent_base_url?: string } }>("/api/v1/settings/agent", async (request, reply) => {
    const url = request.body?.agent_base_url;
    if (typeof url !== "string" || url.trim() === "") return reply.code(400).send({ detail: "agent_base_url 不能为空" });
    db.prepare("INSERT INTO settings(key,value_json) VALUES ('agent_base_url',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(url));
    return { agent_base_url: url };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/settings/sync", async (request) => ({ success: true, synced: Object.keys(request.body ?? {}) }));
  app.get("/api/v1/agent/reminder-config", async () => {
    const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : { id: 0, recruiter_id: "global", enabled: false, mode: "advance", advance_hours: 2, fixed_time: "09:00", script: "" };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/reminder-config", async (request) => { const body = request.body ?? {}; db.prepare("INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('reminder','global',?) ON CONFLICT(kind,recruiter_id) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify({ id: 0, recruiter_id: "global", enabled: Boolean(body.enabled), mode: body.mode ?? "advance", advance_hours: Number(body.advance_hours ?? 2), fixed_time: body.fixed_time ?? "09:00", script: body.script ?? "" })); return JSON.parse(String((db.prepare("SELECT value_json FROM agent_configs WHERE kind='reminder' AND recruiter_id='global'").get() as { value_json: string }).value_json)); });
  app.get("/api/v1/agent/followup-config", async () => { const row = db.prepare("SELECT value_json FROM agent_configs WHERE kind='followup' AND recruiter_id='global'").get() as { value_json: string } | undefined; return row ? JSON.parse(row.value_json) : { id: 0, recruiter_id: "global", enabled: false, interval_seconds: 300, max_count: 3, scripts: [] }; });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent/followup-config", async (request) => { const body = request.body ?? {}; const value = { id: 0, recruiter_id: "global", enabled: Boolean(body.enabled), interval_seconds: Number(body.interval_seconds ?? 300), max_count: Number(body.max_count ?? 3), scripts: Array.isArray(body.scripts) ? body.scripts : [] }; db.prepare("INSERT INTO agent_configs(kind,recruiter_id,value_json) VALUES ('followup','global',?) ON CONFLICT(kind,recruiter_id) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP").run(JSON.stringify(value)); return value; });
  // Target shape: {days: number, items: array} — no per-status counters.
  app.get<{ Querystring: { days?: string } }>("/api/v1/agent/evaluation/overview", async (request) => ({ days: Number(request.query.days ?? 7), items: [] }));
  app.get<{ Querystring: { device_code?: string; eval_date?: string } }>("/api/v1/agent/evaluation/detail", async (request) => ({ device_code: request.query.device_code ?? "", eval_date: request.query.eval_date ?? "", items: [] }));
  // Running an evaluation across devices is admin-only on the target.
  app.post<{ Querystring: { device_code?: string; eval_date?: string } }>("/api/v1/agent/evaluation/run", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin required to evaluate all devices" });
    return { success: true, device_code: request.query.device_code ?? "", eval_date: request.query.eval_date ?? new Date().toISOString().slice(0, 10), total: 0, invited: 0, failed: 0 };
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/agent/report/account-summary", async (request) => ({ prefix: request.query.prefix ?? "", date_range: { start: request.query.start_date ?? "", end: request.query.end_date ?? "" }, total: {}, accounts: [], daily_trend: [] }));
  app.post<{ Body: { ids?: number[]; status?: string; is_active?: boolean } }>("/api/v1/knowledge/batch/update", async (request) => { const ids = Array.isArray(request.body?.ids) ? request.body.ids : []; let updated = 0; for (const id of ids) { const result = db.prepare("UPDATE knowledge_items SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(request.body?.status ?? (request.body?.is_active === false ? "disabled" : "enabled"), Number(id)); updated += Number(result.changes); } return { success: true, updated }; });
  app.post<{ Body: { ids?: number[] } }>("/api/v1/knowledge/batch/delete", async (request) => { const ids = Array.isArray(request.body?.ids) ? request.body.ids : []; let deleted = 0; for (const id of ids) deleted += Number(db.prepare("DELETE FROM knowledge_items WHERE id=?").run(Number(id)).changes); return { success: true, deleted }; });
  // Target shape: {cities: array, unlimited: boolean} — no items envelope.
  // Target item shape: {city_name, interview_site_name}.
  app.get("/api/v1/holiday-schedules/my-cities", async () => {
    const rows = db.prepare("SELECT city_name,data_json FROM cities ORDER BY city_name").all() as Array<{ city_name: string; data_json: string }>;
    return {
      cities: rows.map((row) => {
        const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
        return { city_name: row.city_name, interview_site_name: String(data.interview_site_name ?? "") };
      }),
      unlimited: true,
    };
  });
}
