import type { FastifyInstance } from "fastify";
import { rolePreHandler } from "../../auth/rbac.js";

export async function registerPermissionRoutes(app: FastifyInstance) {
  app.get("/api/v1/recruiter-featured/cities", { preHandler: rolePreHandler("recruiter") }, async (request) => {
    const db = (request.server as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    const rows = db.prepare("SELECT city_id,city_name,position_ids FROM recruiter_featured ORDER BY city_name").all();
    return { items: rows, total: rows.length };
  });
  app.put<{ Params: { id: string }; Body: { position_ids?: number[] } }>("/api/v1/recruiter-featured/cities/:id", { preHandler: rolePreHandler("recruiter") }, async (request) => {
    const db = (request.server as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("INSERT INTO recruiter_featured(city_id,city_name,position_ids) VALUES (?,?,?) ON CONFLICT(city_id) DO UPDATE SET position_ids=excluded.position_ids,updated_at=CURRENT_TIMESTAMP").run(Number(request.params.id), String(request.params.id), JSON.stringify(request.body?.position_ids ?? []));
    return { success: true };
  });
  app.delete<{ Params: { id: string } }>("/api/v1/recruiter-featured/cities/:id", { preHandler: rolePreHandler("recruiter") }, async (request) => {
    const db = (request.server as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("DELETE FROM recruiter_featured WHERE city_id=?").run(Number(request.params.id));
    return { success: true };
  });
}
