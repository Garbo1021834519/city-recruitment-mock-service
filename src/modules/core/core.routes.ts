import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";
import { serializeCity, serializeFactory, serializeServicePosition } from "../../shared/response-serializers.js";
import { canAccessCity, cityConstraint, getUserScope, type UserScope } from "../../auth/user-scopes.js";

function list(db: DatabaseSync, table: string, query: Record<string, unknown>, serialize: (row: Record<string, unknown>) => Record<string, unknown>, where = "", args: Array<string | number | null> = [], scopeFilter?: { sql: string; values: number[] }) {
  const { page, pageSize, offset } = parsePagination(query);
  const scopeSql = scopeFilter?.sql ?? "";
  const fullWhere = where ? `${where}${scopeSql}` : scopeSql ? ` WHERE 1=1${scopeSql}` : "";
  const values = [...args, ...(scopeFilter?.values ?? [])];
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}${fullWhere}`).get(...values) as { count: number }).count;
  const rows = db.prepare(`SELECT * FROM ${table}${fullWhere} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, offset) as Array<Record<string, unknown>>;
  // The target's list envelope is exactly {items, total}; echoing page/page_size
  // is a parity divergence (verified against /cities, /factories, /service-positions).
  return { items: rows.map(serialize), total };
}

export async function registerCoreRoutes(app: FastifyInstance, db: DatabaseSync) {
  const scopeFor = (auth: NonNullable<import("fastify").FastifyRequest["auth"]>) => getUserScope(db, auth);
  const denyCityWrite = (scope: UserScope, cityId: number, reply: import("fastify").FastifyReply) => canAccessCity(scope, cityId) ? null : reply.code(403).send({ detail: "无权访问该城市" });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/cities", async (request) => {
    const where = request.query.status ? " WHERE recruitment_status=?" : "";
    const args = request.query.status ? [String(request.query.status)] : [];
    return list(db, "cities", request.query, serializeCity, where, args, cityConstraint(scopeFor(request.auth!), "id"));
  });
  app.get<{ Params: { id: string } }>("/api/v1/cities/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const row = db.prepare("SELECT * FROM cities WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row || !canAccessCity(scopeFor(request.auth!), id)) return reply.code(404).send({ detail: "城市不存在" });
    return serializeCity(row);
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/cities", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "无权创建城市" });
    if (!request.body?.city_name) return reply.code(422).send({ detail: "城市名称不能为空" });
    const result = db.prepare("INSERT INTO cities(city_name,province,recruitment_status,data_json) VALUES (?,?,?,?)").run(String(request.body.city_name), String(request.body.province ?? ""), String(request.body.recruitment_status ?? "enabled"), JSON.stringify(request.body));
    return serializeCity(db.prepare("SELECT * FROM cities WHERE id=?").get(Number(result.lastInsertRowid)) as Record<string, unknown>);
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/cities/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const before = db.prepare("SELECT * FROM cities WHERE id=?").get(id);
    if (!before || denyCityWrite(scopeFor(request.auth!), id, reply)) return reply.sent ? reply : reply.code(404).send({ detail: "城市不存在" });
    db.prepare("INSERT INTO city_history(city_id,snapshot_json) VALUES (?,?)").run(id, JSON.stringify(before));
    const result = db.prepare("UPDATE cities SET city_name=COALESCE(?,city_name),province=COALESCE(?,province),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(typeof request.body?.city_name === "string" ? request.body.city_name : null, typeof request.body?.province === "string" ? request.body.province : null, JSON.stringify(request.body ?? {}), id);
    return result.changes ? serializeCity(db.prepare("SELECT * FROM cities WHERE id=?").get(id) as Record<string, unknown>) : reply.code(404).send({ detail: "城市不存在" });
  });
  // The target rejects a non-admin delete with 403 before any lookup.
  app.delete<{ Params: { id: string } }>("/api/v1/cities/:id", async (request, reply) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "无权删除该城市" });
    const result = db.prepare("DELETE FROM cities WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "City not found" });
  });
  app.patch<{ Params: { id: string }; Body: { recruitment_status?: string } }>("/api/v1/cities/:id/status", async (request, reply) => { const id = Number(request.params.id); if (denyCityWrite(scopeFor(request.auth!), id, reply)) return reply.sent ? reply : reply.code(404).send({ detail: "城市不存在" }); const result = db.prepare("UPDATE cities SET recruitment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(typeof request.body?.recruitment_status === "string" ? request.body.recruitment_status : "enabled", id); return result.changes ? serializeCity(db.prepare("SELECT * FROM cities WHERE id=?").get(id) as Record<string, unknown>) : reply.code(404).send({ detail: "城市不存在" }); });
  // City-factory relations live on factories.city_id. The target 404s with
  // "City not found" for a missing or inaccessible city before listing.
  const cityExists = (id: number) => Boolean(db.prepare("SELECT id FROM cities WHERE id=?").get(id));
  app.get<{ Params: { id: string } }>("/api/v1/cities/:id/factories", async (request, reply) => {
    const cityId = Number(request.params.id);
    if (!cityExists(cityId) || !canAccessCity(scopeFor(request.auth!), cityId)) return reply.code(404).send({ detail: "City not found" });
    const rows = db.prepare("SELECT * FROM factories WHERE city_id=? ORDER BY id DESC").all(cityId) as Array<Record<string, unknown>>;
    return { items: rows.map(serializeFactory), total: rows.length };
  });
  app.put<{ Params: { id: string; factoryId: string } }>("/api/v1/cities/:id/factories/:factoryId", async (request, reply) => {
    const cityId = Number(request.params.id);
    if (!cityExists(cityId)) return reply.code(404).send({ detail: "City not found" });
    if (denyCityWrite(scopeFor(request.auth!), cityId, reply)) return reply;
    const result = db.prepare("UPDATE factories SET city_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(cityId, Number(request.params.factoryId));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "City not found" });
  });
  app.delete<{ Params: { id: string; factoryId: string } }>("/api/v1/cities/:id/factories/:factoryId", async (request, reply) => {
    const cityId = Number(request.params.id);
    if (!cityExists(cityId)) return reply.code(404).send({ detail: "City not found" });
    if (denyCityWrite(scopeFor(request.auth!), cityId, reply)) return reply;
    const result = db.prepare("UPDATE factories SET city_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND city_id=?").run(Number(request.params.factoryId), cityId);
    return result.changes ? { success: true } : reply.code(404).send({ detail: "City not found" });
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/factories", async (request) => list(db, "factories", request.query, serializeFactory, "", [], cityConstraint(scopeFor(request.auth!), "city_id")));
  app.get<{ Params: { id: string } }>("/api/v1/factories/:id", async (request, reply) => { const row = db.prepare("SELECT * FROM factories WHERE id=?").get(Number(request.params.id)) as (Record<string, unknown> & { city_id: number }) | undefined; return row && canAccessCity(scopeFor(request.auth!), Number(row.city_id)) ? serializeFactory(row) : reply.code(404).send({ detail: "工厂不存在" }); });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/factories", async (request, reply) => { const cityId = typeof request.body?.city_id === "number" ? request.body.city_id : null; if (cityId === null || denyCityWrite(scopeFor(request.auth!), cityId, reply)) return reply.sent ? reply : reply.code(422).send({ detail: "city_id is required" }); const row = db.prepare("INSERT INTO factories(factory_name,city_id,data_json) VALUES (?,?,?) RETURNING *").get(String(request.body?.factory_name ?? request.body?.name ?? "本地工厂"), cityId, JSON.stringify(request.body ?? {})) as Record<string, unknown>; return serializeFactory(row); });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/factories/:id", async (request, reply) => { const id = Number(request.params.id); const current = db.prepare("SELECT city_id FROM factories WHERE id=?").get(id) as { city_id: number } | undefined; if (!current || denyCityWrite(scopeFor(request.auth!), Number(current.city_id), reply)) return reply.sent ? reply : reply.code(404).send({ detail: "工厂不存在" }); const cityId = typeof request.body?.city_id === "number" ? request.body.city_id : Number(current.city_id); if (denyCityWrite(scopeFor(request.auth!), cityId, reply)) return reply; const name = request.body?.factory_name ?? request.body?.name; const result = db.prepare("UPDATE factories SET factory_name=COALESCE(?,factory_name),city_id=COALESCE(?,city_id),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(typeof name === "string" ? name : null, typeof request.body?.city_id === "number" ? request.body.city_id : null, JSON.stringify(request.body ?? {}), id); return result.changes ? serializeFactory(db.prepare("SELECT * FROM factories WHERE id=?").get(id) as Record<string, unknown>) : reply.code(404).send({ detail: "工厂不存在" }); });
  app.delete<{ Params: { id: string } }>("/api/v1/factories/:id", async (request, reply) => { const id = Number(request.params.id); const row = db.prepare("SELECT city_id FROM factories WHERE id=?").get(id) as { city_id: number } | undefined; if (!row) return reply.code(404).send({ detail: "工厂不存在" }); if (denyCityWrite(scopeFor(request.auth!), Number(row.city_id), reply)) return reply; db.prepare("DELETE FROM factories WHERE id=?").run(id); return { success: true }; });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/service-positions", async (request) => {
    const city = request.query.city_name;
    return list(db, "service_positions", request.query, serializeServicePosition, typeof city === "string" ? " WHERE city_id=(SELECT id FROM cities WHERE city_name=?)" : "", typeof city === "string" ? [city] : [], cityConstraint(scopeFor(request.auth!), "city_id"));
  });
  app.get<{ Params: { id: string } }>("/api/v1/service-positions/:id", async (request, reply) => { const row = db.prepare("SELECT * FROM service_positions WHERE id=?").get(Number(request.params.id)) as (Record<string, unknown> & { city_id: number }) | undefined; return row && canAccessCity(scopeFor(request.auth!), Number(row.city_id)) ? serializeServicePosition(row) : reply.code(404).send({ detail: "岗位不存在" }); });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/service-positions", async (request, reply) => { const cityId = typeof request.body?.city_id === "number" ? request.body.city_id : null; if (cityId === null || denyCityWrite(scopeFor(request.auth!), cityId, reply)) return reply.sent ? reply : reply.code(422).send({ detail: "city_id is required" }); const row = db.prepare("INSERT INTO service_positions(position_name,factory_id,city_id,data_json) VALUES (?,?,?,?) RETURNING *").get(String(request.body?.position_name ?? request.body?.name ?? "本地岗位"), typeof request.body?.factory_id === "number" ? request.body.factory_id : null, cityId, JSON.stringify(request.body ?? {})) as Record<string, unknown>; return serializeServicePosition(row); });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/service-positions/:id", async (request, reply) => { const id = Number(request.params.id); const current = db.prepare("SELECT city_id FROM service_positions WHERE id=?").get(id) as { city_id: number } | undefined; if (!current || denyCityWrite(scopeFor(request.auth!), Number(current.city_id), reply)) return reply.sent ? reply : reply.code(404).send({ detail: "岗位不存在" }); const cityId = typeof request.body?.city_id === "number" ? request.body.city_id : Number(current.city_id); if (denyCityWrite(scopeFor(request.auth!), cityId, reply)) return reply; const name = request.body?.position_name ?? request.body?.name; const result = db.prepare("UPDATE service_positions SET position_name=COALESCE(?,position_name),factory_id=COALESCE(?,factory_id),city_id=COALESCE(?,city_id),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(typeof name === "string" ? name : null, typeof request.body?.factory_id === "number" ? request.body.factory_id : null, typeof request.body?.city_id === "number" ? request.body.city_id : null, JSON.stringify(request.body ?? {}), id); return result.changes ? serializeServicePosition(db.prepare("SELECT * FROM service_positions WHERE id=?").get(id) as Record<string, unknown>) : reply.code(404).send({ detail: "岗位不存在" }); });
  app.delete<{ Params: { id: string } }>("/api/v1/service-positions/:id", async (request, reply) => { const id = Number(request.params.id); const row = db.prepare("SELECT city_id FROM service_positions WHERE id=?").get(id) as { city_id: number } | undefined; if (!row) return reply.code(404).send({ detail: "岗位不存在" }); if (denyCityWrite(scopeFor(request.auth!), Number(row.city_id), reply)) return reply; db.prepare("DELETE FROM service_positions WHERE id=?").run(id); return { success: true }; });
  app.put<{ Params: { id: string } }>("/api/v1/service-positions/:id/toggle-featured", async (request, reply) => { const id = Number(request.params.id); const current = db.prepare("SELECT city_id FROM service_positions WHERE id=?").get(id) as { city_id: number } | undefined; if (!current || denyCityWrite(scopeFor(request.auth!), Number(current.city_id), reply)) return reply.sent ? reply : reply.code(404).send({ detail: "岗位不存在" }); const result = db.prepare("UPDATE service_positions SET featured=1-featured,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id); return result.changes ? serializeServicePosition(db.prepare("SELECT * FROM service_positions WHERE id=?").get(id) as Record<string, unknown>) : reply.code(404).send({ detail: "岗位不存在" }); });
  // Target 404s when the parent position is missing and counts the real total.
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/api/v1/service-positions/:id/holidays", async (request, reply) => {
    const positionId = Number(request.params.id);
    const position = db.prepare("SELECT city_id FROM service_positions WHERE id=?").get(positionId) as { city_id: number } | undefined;
    if (!position || !canAccessCity(scopeFor(request.auth!), Number(position.city_id))) return reply.code(404).send({ detail: "Service position not found" });
    const rows = db.prepare("SELECT * FROM service_position_holidays WHERE position_id=? ORDER BY holiday_date").all(positionId);
    return { items: rows, total: rows.length };
  });
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/service-positions/:id/holidays", async (request, reply) => { const positionId = Number(request.params.id); const position = db.prepare("SELECT city_id FROM service_positions WHERE id=?").get(positionId) as { city_id: number } | undefined; if (!position || !canAccessCity(scopeFor(request.auth!), Number(position.city_id))) return reply.code(404).send({ detail: "Service position not found" }); return db.prepare("INSERT INTO service_position_holidays(position_id,holiday_date,label,is_active,data_json) VALUES (?,?,?,?,?) RETURNING *").get(positionId, String(request.body?.holiday_date ?? request.body?.date ?? ""), String(request.body?.label ?? ""), request.body?.is_active === false ? 0 : 1, JSON.stringify(request.body ?? {})); });
  app.put<{ Params: { id: string; holidayId: string }; Body: Record<string, unknown> }>("/api/v1/service-positions/:id/holidays/:holidayId", async (request, reply) => { const position = db.prepare("SELECT city_id FROM service_positions WHERE id=?").get(Number(request.params.id)) as { city_id: number } | undefined; if (!position || !canAccessCity(scopeFor(request.auth!), Number(position.city_id))) return reply.code(404).send({ detail: "Service position not found" }); const result = db.prepare("UPDATE service_position_holidays SET holiday_date=COALESCE(?,holiday_date),label=COALESCE(?,label),is_active=COALESCE(?,is_active),data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND position_id=?").run(typeof request.body?.holiday_date === "string" ? request.body.holiday_date : null, typeof request.body?.label === "string" ? request.body.label : null, typeof request.body?.is_active === "boolean" ? (request.body.is_active ? 1 : 0) : null, JSON.stringify(request.body ?? {}), Number(request.params.holidayId), Number(request.params.id)); return result.changes ? db.prepare("SELECT * FROM service_position_holidays WHERE id=?").get(Number(request.params.holidayId)) : reply.code(404).send({ detail: "假期记录不存在" }); });
  app.delete<{ Params: { id: string; holidayId: string } }>("/api/v1/service-positions/:id/holidays/:holidayId", async (request, reply) => {
    const position = db.prepare("SELECT city_id FROM service_positions WHERE id=?").get(Number(request.params.id)) as { city_id: number } | undefined;
    if (!position || !canAccessCity(scopeFor(request.auth!), Number(position.city_id))) return reply.code(404).send({ detail: "Service position not found" });
    const result = db.prepare("DELETE FROM service_position_holidays WHERE id=? AND position_id=?").run(Number(request.params.holidayId), Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Service position not found" });
  });
}
