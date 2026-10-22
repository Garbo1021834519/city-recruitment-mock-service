import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

type Contract = { method: string; path: string };
const handled = new Set([
  "GET /api/v1/cities", "GET /api/v1/cities/:id", "POST /api/v1/cities", "PUT /api/v1/cities/:id", "DELETE /api/v1/cities/:id", "PATCH /api/v1/cities/:id/status",
  "GET /api/v1/factories", "GET /api/v1/factories/:id", "POST /api/v1/factories", "PUT /api/v1/factories/:id", "DELETE /api/v1/factories/:id",
  "GET /api/v1/service-positions", "GET /api/v1/service-positions/:id", "POST /api/v1/service-positions", "PUT /api/v1/service-positions/:id", "DELETE /api/v1/service-positions/:id", "PUT /api/v1/service-positions/:id/toggle-featured",
  "POST /api/v1/auth/login", "GET /api/v1/auth/me", "GET /api/v1/auth/users", "POST /api/v1/auth/users", "DELETE /api/v1/auth/users/:id",
  "GET /api/v1/import-export/template", "GET /api/v1/import-export/factories/export", "GET /api/v1/import-export/service-positions/export", "GET /api/v1/service-positions/holidays-export", "GET /api/v1/activation/scripts/export",
  "POST /api/v1/import-export/import", "POST /api/v1/import-export/factories/import", "POST /api/v1/import-export/service-positions/import", "POST /api/v1/service-positions/holidays-import", "POST /api/v1/activation/scripts/import", "POST /api/v1/knowledge/batch/import",
  "POST /api/v1/upload/image", "POST /api/v1/upload/video",
  "GET /api/v1/agent/devices", "POST /api/v1/agent/devices", "PUT /api/v1/agent/devices/:id", "DELETE /api/v1/agent/devices/:id", "GET /api/v1/agent/conversations", "GET /api/v1/agent/messages", "POST /api/v1/agent/takeover", "POST /api/v1/agent/manual-reply", "GET /api/v1/agent/candidates", "GET /api/v1/agent/status/dashboard", "PUT /api/v1/agent/conversations/:id/restart", "PUT /api/v1/agent/conversations/:id/reset-disqualified",
  "GET /api/v1/activation/records", "GET /api/v1/activation/dashboard/stats", "GET /api/v1/activation/dashboard/trend", "GET /api/v1/activation/dashboard/population", "GET /api/v1/activation/dashboard/strategy-effect", "GET /api/v1/activation/dashboard/feed", "GET /api/v1/activation/config", "PUT /api/v1/activation/config/paused", "POST /api/v1/activation/records/:id/approve", "POST /api/v1/activation/records/:id/skip", "POST /api/v1/activation/records/:id/freeze", "POST /api/v1/activation/records/:id/run", "GET /api/v1/activation/strategies", "GET /api/v1/activation/devices", "GET /api/v1/activation/customers/:id",
  "GET /api/v1/recruiter-featured/cities", "PUT /api/v1/recruiter-featured/cities/:id", "DELETE /api/v1/recruiter-featured/cities/:id",
  "GET /api/v1/city-links", "POST /api/v1/city-links/batch",
  "GET /api/v1/agent/reminder-config", "POST /api/v1/agent/reminder-config", "GET /api/v1/agent/followup-config", "POST /api/v1/agent/followup-config", "GET /api/v1/agent/evaluation/overview", "GET /api/v1/agent/evaluation/detail", "POST /api/v1/agent/evaluation/run", "GET /api/v1/agent/report/account-summary", "POST /api/v1/agent/candidates", "GET /api/v1/agent/candidates",
  "GET /api/v1/activation/scripts/random",
  "POST /api/v1/activation/scripts", "PUT /api/v1/activation/scripts/:id", "DELETE /api/v1/activation/scripts/:id", "PUT /api/v1/activation/config", "PUT /api/v1/activation/strategies/:id", "POST /api/v1/activation/strategies/:id/test", "PUT /api/v1/activation/devices/:id", "POST /api/v1/activation/devices/batch-toggle", "POST /api/v1/settings/sync",
  "GET /api/v1/agent/old-friends", "GET /api/v1/agent/old-friends/accounts", "POST /api/v1/agent/old-friends/mark", "PUT /api/v1/agent/old-friends/:id/release", "PUT /api/v1/agent/old-friends/:id/unrelease", "DELETE /api/v1/agent/old-friends/:id",
  "GET /api/v1/cities/:id/history", "GET /api/v1/cities/:id/history/:id", "POST /api/v1/cities/:id/restore/:id", "GET /api/v1/city-links", "POST /api/v1/city-links/batch", "GET /api/v1/recruiters/:id/cities", "POST /api/v1/recruiters/:id/cities", "POST /api/v1/recruiters/:id/cities/batch", "DELETE /api/v1/recruiters/:id/cities/:id", "GET /api/v1/recruiters/:id/service-cities", "GET /api/v1/recruiters/:id/service-cities/options", "GET /api/v1/holiday-schedules/my-cities", "GET /api/v1/service-positions/:id/holidays", "POST /api/v1/service-positions/:id/holidays", "PUT /api/v1/service-positions/:id/holidays/:id", "DELETE /api/v1/service-positions/:id/holidays/:id",
]);

function contracts(): Contract[] {
  const file = path.resolve(process.cwd(), "过程文件", "api-contracts.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")).paths as Contract[]; } catch { return []; }
}

function cleanRoute(route: string) { return route.replace(/\?.*$/, ""); }

export async function registerGenericRoutes(app: FastifyInstance) {
  for (const contract of contracts()) {
    const method = contract.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    const route = cleanRoute(contract.path);
    if (handled.has(`${contract.method} ${route}`) || !route.startsWith("/api/v1/") || !app.hasRoute) continue;
    if (app.hasRoute({ method: method.toUpperCase(), url: route })) continue;
    app.route({ method: method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: route, handler: async (request, reply) => {
      if (method === "get") {
        if (route.includes("/export") || route.includes("/template")) return reply.type("application/octet-stream").send(Buffer.from("local export placeholder"));
        if (route.endsWith("/config") || route.endsWith("/settings")) return {};
        if (route.includes(":id") && !route.endsWith("/:id")) return { items: [], total: 0 };
        return { items: [], total: 0, page: 1, page_size: 20 };
      }
      if (method === "delete") return { success: true };
      return { success: true, ...(typeof request.body === "object" && request.body !== null ? request.body : {}) };
    } });
  }
}
