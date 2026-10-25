import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { parsePagination } from "../../shared/pagination.js";
import { serializeCityLinks } from "../../shared/response-serializers.js";
import { canAccessCity, canAccessRecruiter, getUserScope } from "../../auth/user-scopes.js";

export async function registerRelationRoutes(app: FastifyInstance, db: DatabaseSync) {
  const userScope = (request: import("fastify").FastifyRequest) => getUserScope(db, request.auth!);
  // Target 404s with "City not found" when the city is missing, then returns
  // the plain {items, total} envelope (no page/page_size).
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/api/v1/cities/:id/history", async (request, reply) => {
    const cityId = Number(request.params.id);
    if (!db.prepare("SELECT id FROM cities WHERE id=?").get(cityId) || !canAccessCity(userScope(request), cityId)) return reply.code(404).send({ detail: "City not found" });
    const { pageSize, offset } = parsePagination(request.query);
    const rows = db.prepare("SELECT * FROM city_history WHERE city_id=? ORDER BY id DESC LIMIT ? OFFSET ?").all(cityId, pageSize, offset);
    const total = (db.prepare("SELECT COUNT(*) count FROM city_history WHERE city_id=?").get(cityId) as { count: number }).count;
    return { items: rows, total };
  });
  app.get<{ Params: { id: string } }>("/api/v1/cities/:id/history/:historyId", async (request, reply) => { const cityId = Number(request.params.id); if (!canAccessCity(userScope(request), cityId)) return reply.code(404).send({ detail: "历史记录不存在" }); const row = db.prepare("SELECT * FROM city_history WHERE id=? AND city_id=?").get(Number((request.params as { id: string; historyId: string }).historyId), cityId) as { snapshot_json: string } | undefined; return row ? JSON.parse(row.snapshot_json) : reply.code(404).send({ detail: "历史记录不存在" }); });
  app.post<{ Params: { id: string; historyId: string } }>("/api/v1/cities/:id/restore/:historyId", async (request, reply) => { const cityId = Number(request.params.id); if (!canAccessCity(userScope(request), cityId)) return reply.code(404).send({ detail: "历史记录不存在" }); const row = db.prepare("SELECT snapshot_json FROM city_history WHERE id=? AND city_id=?").get(Number(request.params.historyId), cityId) as { snapshot_json: string } | undefined; if (!row) return reply.code(404).send({ detail: "历史记录不存在" }); const snapshot = JSON.parse(row.snapshot_json); db.prepare("UPDATE cities SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(snapshot), cityId); return { success: true, city: snapshot }; });
  /**
   * Target shape: {options: [{city, count}], default_districts: {city: [...]}}
   * — counted links per city plus the built-in district list per city.
   */
  app.get("/api/v1/city-links/options", async (request) => {
    const scope = userScope(request);
    const visible = scope.isAdmin ? null : scope.cityIds;
    const constraint = visible ? visible.length ? ` WHERE c.id IN (${visible.map(() => "?").join(",")})` : " WHERE 1=0" : "";
    const values = visible ?? [];
    const counts = db.prepare(`SELECT c.city_name AS city, COUNT(l.linked_city_id) AS count FROM cities c LEFT JOIN city_links l ON l.city_id = c.id${constraint} GROUP BY c.id ORDER BY c.city_name`).all(...values) as Array<{ city: string; count: number }>;
    const cityRows = db.prepare(`SELECT city_name,data_json,id FROM cities${visible ? visible.length ? ` WHERE id IN (${visible.map(() => "?").join(",")})` : " WHERE 1=0" : ""}`).all(...values) as Array<{ id: number; city_name: string; data_json: string }>;
    const default_districts: Record<string, string[]> = {};
    for (const row of cityRows) {
      const data = typeof row.data_json === "string" ? JSON.parse(row.data_json) : {};
      default_districts[row.city_name] = Array.isArray(data.districts) ? data.districts : [];
    }
    return { options: counts.map((row) => ({ city: row.city, count: Number(row.count) })), default_districts };
  });
  // Target shape: {districts: object, links: object} — no items/total envelope.
  app.get("/api/v1/city-links", async (request) => {
    const scope = userScope(request);
    const rows = db.prepare("SELECT source.city_name AS city, target.city_name AS linked_city FROM city_links l JOIN cities source ON source.id=l.city_id JOIN cities target ON target.id=l.linked_city_id ORDER BY source.city_name,target.city_name").all() as Array<{ city: string; linked_city: string }>;
    const links: Record<string, string[]> = {};
    const allowedNames = new Set((db.prepare("SELECT id,city_name FROM cities").all() as Array<{ id: number; city_name: string }>).filter((city) => canAccessCity(scope, city.id)).map((city) => city.city_name));
    for (const row of rows) if (allowedNames.has(row.city) && allowedNames.has(row.linked_city)) (links[row.city] ??= []).push(row.linked_city);
    const cityRows = db.prepare("SELECT city_name,data_json FROM cities ORDER BY city_name").all() as Array<{ city_name: string; data_json: string }>;
    const districts: Record<string, string[]> = {};
    for (const city of cityRows) {
      if (!allowedNames.has(city.city_name)) continue;
      const data = typeof city.data_json === "string" ? JSON.parse(city.data_json) : {};
      districts[city.city_name] = Array.isArray(data.districts) ? data.districts : [];
    }
    return serializeCityLinks({ districts, links });
  });
  // Target responds 201 {saved: n} — the count of links actually written.
  app.post<{ Body: { city_id?: number; linked_city_ids?: number[] } }>("/api/v1/city-links/batch", async (request, reply) => {
    const cityId = Number(request.body?.city_id ?? 0);
    const linked = Array.isArray(request.body?.linked_city_ids) ? request.body.linked_city_ids : [];
    const scope = userScope(request);
    if (!canAccessCity(scope, cityId) || linked.some((id) => !canAccessCity(scope, Number(id)))) return reply.code(403).send({ detail: "无权设置该城市关联" });
    db.prepare("DELETE FROM city_links WHERE city_id=?").run(cityId);
    let saved = 0;
    for (const linkedId of linked) saved += Number(db.prepare("INSERT OR IGNORE INTO city_links(city_id,linked_city_id) SELECT ?,id FROM cities WHERE id=?").run(cityId, Number(linkedId)).changes);
    return reply.code(201).send({ saved });
  });
  app.get<{ Params: { id: string } }>("/api/v1/recruiters/:id/cities", async (request, reply) => {
    const recruiterId = Number(request.params.id);
    const scope = userScope(request);
    if (!recruiterExists(recruiterId) || !canAccessRecruiter(scope, String(recruiterId))) return reply.code(404).send({ detail: "Recruiter not found" });
    const rows = (db.prepare("SELECT rc.*,c.city_name FROM recruiter_cities rc JOIN cities c ON c.id=rc.city_id WHERE rc.recruiter_id=? AND rc.is_service=0 ORDER BY rc.sort_order,c.city_name").all(recruiterId) as Array<{ city_id: number }>).filter((row) => canAccessCity(scope, row.city_id));
    return { items: rows, total: rows.length };
  });
  app.post<{ Params: { id: string }; Body: { city_id?: number } }>("/api/v1/recruiters/:id/cities", async (request, reply) => { const recruiterId = Number(request.params.id); const cityId = Number(request.body?.city_id); const scope = userScope(request); if (!recruiterExists(recruiterId) || !canAccessRecruiter(scope, String(recruiterId))) return reply.code(404).send({ detail: "Recruiter not found" }); if (!canAccessCity(scope, cityId)) return reply.code(403).send({ detail: "无权关联该城市" }); db.prepare("INSERT OR REPLACE INTO recruiter_cities(recruiter_id,city_id,is_service) VALUES (?,?,0)").run(recruiterId, cityId); return { success: true }; });
  app.post<{ Params: { id: string }; Body: { city_ids?: number[] } }>("/api/v1/recruiters/:id/cities/batch", async (request, reply) => { const recruiterId = Number(request.params.id); const ids = Array.isArray(request.body?.city_ids) ? request.body.city_ids : []; const scope = userScope(request); if (!recruiterExists(recruiterId) || !canAccessRecruiter(scope, String(recruiterId))) return reply.code(404).send({ detail: "Recruiter not found" }); if (ids.some((cityId) => !canAccessCity(scope, Number(cityId)))) return reply.code(403).send({ detail: "无权关联该城市" }); for (const cityId of ids) db.prepare("INSERT OR REPLACE INTO recruiter_cities(recruiter_id,city_id,is_service) VALUES (?,?,0)").run(recruiterId, Number(cityId)); return { success: true, added: ids.length }; });
  app.put<{ Params: { id: string; cityId: string } }>("/api/v1/recruiters/:id/cities/:cityId", async (request, reply) => {
    const recruiterId = Number(request.params.id);
    if (!recruiterExists(recruiterId) || !canAccessRecruiter(userScope(request), String(recruiterId))) return reply.code(404).send({ detail: "Recruiter not found" });
    if (!canAccessCity(userScope(request), Number(request.params.cityId))) return reply.code(403).send({ detail: "无权关联该城市" });
    const result = db.prepare("INSERT OR REPLACE INTO recruiter_cities(recruiter_id,city_id,is_service) VALUES (?,?,0)").run(recruiterId, Number(request.params.cityId));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Recruiter not found" });
  });
  // The target never returns a password; it only reports whether one is set.
  app.put<{ Params: { id: string }; Body: { password?: string } }>("/api/v1/recruiters/:id/password", async (request, reply) => {
    const recruiterId = Number(request.params.id);
    if (!recruiterExists(recruiterId) || !canAccessRecruiter(userScope(request), String(recruiterId))) return reply.code(404).send({ detail: "Recruiter not found" });
    if (typeof request.body?.password !== "string" || request.body.password === "") return reply.code(400).send({ detail: "password 不能为空" });
    const { hashPassword } = await import("../../db/seed.js");
    db.prepare("UPDATE recruiters SET data_json=json_set(data_json,'$.password_set',1,'$.password_hash',?),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hashPassword(request.body.password), recruiterId);
    return { success: true };
  });
  app.delete<{ Params: { id: string; cityId: string } }>("/api/v1/recruiters/:id/cities/:cityId", async (request, reply) => {
    const recruiterId = Number(request.params.id);
    const scope = userScope(request);
    if (!recruiterExists(recruiterId) || !canAccessRecruiter(scope, String(recruiterId))) return reply.code(404).send({ detail: "Recruiter not found" });
    if (!canAccessCity(scope, Number(request.params.cityId))) return reply.code(403).send({ detail: "无权关联该城市" });
    const result = db.prepare("DELETE FROM recruiter_cities WHERE recruiter_id=? AND city_id=? AND is_service=0").run(recruiterId, Number(request.params.cityId));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "Recruiter not found" });
  });
  // Both 404 with "Recruiter not found" when the recruiter is missing.
  const recruiterExists = (id: number) => Boolean(db.prepare("SELECT id FROM recruiters WHERE id=?").get(id));
  app.get<{ Params: { id: string } }>("/api/v1/recruiters/:id/service-cities", async (request, reply) => {
    const recruiterId = Number(request.params.id);
    const scope = userScope(request);
    if (!recruiterExists(recruiterId) || !canAccessRecruiter(scope, request.params.id)) return reply.code(404).send({ detail: "Recruiter not found" });
    const rows = (db.prepare("SELECT rc.*,c.city_name FROM recruiter_cities rc JOIN cities c ON c.id=rc.city_id WHERE rc.recruiter_id=? AND rc.is_service=1 ORDER BY c.city_name").all(recruiterId) as Array<{ city_id: number }>).filter((row) => canAccessCity(scope, row.city_id));
    return { items: rows };
  });
  app.get<{ Params: { id: string } }>("/api/v1/recruiters/:id/service-cities/options", async (request, reply) => {
    if (!recruiterExists(Number(request.params.id)) || !canAccessRecruiter(userScope(request), request.params.id)) return reply.code(404).send({ detail: "Recruiter not found" });
    const scope = userScope(request);
    const constraint = scope.isAdmin ? "" : scope.cityIds.length ? ` WHERE id IN (${scope.cityIds.map(() => "?").join(",")})` : " WHERE 1=0";
    return { items: db.prepare(`SELECT id,city_name FROM cities${constraint} ORDER BY city_name`).all(...(scope.isAdmin ? [] : scope.cityIds)) };
  });
}
