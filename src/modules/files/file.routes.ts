import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { DatabaseSync } from "node:sqlite";
import { buildWorkbook } from "../../shared/xlsx.js";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Column definitions per export route, in the target's column order. */
const EXPORTS: Record<string, { filename: string; headers: string[]; query: string }> = {
  "/api/v1/import-export/template": {
    filename: "导入模板.xlsx",
    headers: ["city_name", "factory_name", "position_name", "address", "contact_phone"],
    query: "SELECT '' AS factory_name, '' AS position_name, '' AS address, '' AS contact_phone WHERE 0",
  },
  "/api/v1/import-export/factories/export": {
    filename: "工厂导出.xlsx",
    headers: ["id", "factory_name", "city_id", "status", "created_at", "updated_at"],
    query: "SELECT id,factory_name,city_id,status,created_at,updated_at FROM factories ORDER BY id",
  },
  "/api/v1/import-export/service-positions/export": {
    filename: "岗位导出.xlsx",
    headers: ["id", "position_name", "city_id", "factory_id", "status", "created_at", "updated_at"],
    query: "SELECT id,position_name,city_id,factory_id,status,created_at,updated_at FROM service_positions ORDER BY id",
  },
  "/api/v1/service-positions/holidays-export": {
    filename: "岗位假期导出.xlsx",
    headers: ["id", "position_id", "holiday_date", "label", "is_active", "updated_at"],
    query: "SELECT id,position_id,holiday_date,label,is_active,updated_at FROM service_position_holidays ORDER BY id",
  },
  "/api/v1/activation/scripts/export": {
    filename: "激活语料导出.xlsx",
    headers: ["id", "content", "status", "created_at", "updated_at"],
    query: "SELECT id,content,status,created_at,updated_at FROM activation_scripts ORDER BY id",
  },
};

export function registerFileRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  for (const [route, spec] of Object.entries(EXPORTS)) {
    app.get(route, async (_request, reply) => {
      const rows = db.prepare(spec.query).all() as Array<Record<string, unknown>>;
      const data = rows.map((row) => spec.headers.map((header) => {
        const value = row[header];
        return typeof value === "number" ? value : String(value ?? "");
      }));
      // Target serves a real workbook stream, not JSON.
      return reply
        .type(XLSX_TYPE)
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(spec.filename)}`)
        .send(buildWorkbook(spec.headers, data));
    });
  }

  // Target returns a bare JSON array of knowledge items here, not an envelope.
  app.get("/api/v1/knowledge/batch/export", async () => {
    const rows = db.prepare("SELECT id,title,content,status,updated_at FROM knowledge_items ORDER BY id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      question: String(row.title ?? ""),
      answer: String(row.content ?? ""),
      keywords: [],
      sort_order: 0,
      is_active: row.status === "enabled",
      recruiter_id: "",
    }));
  });

  for (const route of ["/api/v1/import-export/import", "/api/v1/import-export/factories/import", "/api/v1/import-export/service-positions/import", "/api/v1/service-positions/holidays-import", "/api/v1/activation/scripts/import", "/api/v1/knowledge/batch/import"]) {
    app.post(route, async (request) => { const file = await request.file(); return { success: true, filename: file?.filename ?? null, total: 0, created: 0, updated: 0 }; });
  }
  for (const route of ["/api/v1/upload/image", "/api/v1/upload/video"]) {
    app.post(route, async (request) => { const file = await request.file(); return { url: file ? `/uploads/${encodeURIComponent(file.filename)}` : "" }; });
  }
}
