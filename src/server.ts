import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { migrateDatabase } from "./db/migrate.js";
import { seedDatabase } from "./db/seed.js";
import { AuthService } from "./auth/auth.service.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import { AUTH_INVALID, AUTH_MISSING } from "./auth/rbac.js";
import { collectValidationErrors, matchContract } from "./shared/request-contracts.js";
import { registerCoreRoutes } from "./modules/core/core.routes.js";
import { registerGenericRoutes } from "./modules/generic/generic.routes.js";
import { registerResourceRoutes } from "./modules/resources/resource.routes.js";
import { registerFileRoutes } from "./modules/files/file.routes.js";
import { registerAgentRoutes } from "./modules/agent/agent.routes.js";
import { registerActivationRoutes } from "./modules/activation/activation.routes.js";
import { registerRelationRoutes } from "./modules/relations/relations.routes.js";
import { registerPermissionRoutes } from "./modules/permissions/permission.routes.js";
import { registerAdminRoutes } from "./modules/admin/admin.routes.js";

declare module "fastify" {
  interface FastifyInstance { db: DatabaseSync }
  interface FastifyRequest { authToken: string }
}

/**
 * Endpoints the target serves without authentication.
 * Verified 2026-10-21 against http://47.107.245.246:8080 — these returned 200
 * with real payloads while every other contract returned 403.
 */
const PUBLIC_ROUTES = new Set([
  "POST /api/v1/auth/login",
  "GET /api/v1/agent/reminder-config",
  "GET /api/v1/agent/followup-config",
  "GET /api/v1/agent/report/account-summary",
  // Device-called endpoints: device_code is a required query parameter, not a
  // secret. The target answers 422 when it is absent and 404 for an unknown
  // conversation even when the value is fake, with or without a bearer token.
  "PUT /api/v1/agent/conversations/:id/restart",
  "PUT /api/v1/agent/conversations/:id/reset-disqualified",
]);

interface RoutePattern { method: string; regex: RegExp }

/** Convert a Fastify route pattern ("/api/v1/cities/:id") into a path matcher. */
function toRegex(routeUrl: string): RegExp {
  const body = routeUrl
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "[^/]+");
  return new RegExp(`^${body}/?$`);
}

export function buildServer() {
  const app = Fastify({ logger: false });
  const db = openDatabase(process.env.REA_DATABASE_PATH ?? config.databasePath);
  migrateDatabase(db);
  seedDatabase(db);
  const auth = new AuthService(db, config.jwtSecret);
  app.decorate("db", db);
  app.decorateRequest("authToken", "");

  // Collect every registered API route so the not-found handler can tell a
  // wrong method (405) apart from an unknown path (404), as the target does.
  const routePatterns: RoutePattern[] = [];
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/")) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routePatterns.push({ method, regex: toRegex(route.url) });
  });

  // Fastify validates route schemas with Ajv and reports 400. The target reports
  // 422 with Pydantic's {type, loc, msg} list, so remap validation failures here.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) return reply.code(422).send({ detail: pydanticErrors(error) });
    return reply.code(error.statusCode ?? 500).send({ detail: error.message });
  });

  app.register(fastifyStatic, { root: path.resolve(process.cwd(), "public"), wildcard: false });
  registerAuthRoutes(app, auth);
  registerCoreRoutes(app, db);
  registerResourceRoutes(app, db);
  registerFileRoutes(app, db);
  registerAgentRoutes(app, db);
  registerActivationRoutes(app, db);
  registerRelationRoutes(app, db);
  registerPermissionRoutes(app);
  registerAdminRoutes(app, db);
  registerGenericRoutes(app);

  // preHandler runs only after routing and schema validation, matching the
  // target's order: unknown paths fall through to 404, wrong methods to 405,
  // malformed bodies to 422, and only then does authentication answer 403/401.
  // Match against registered route patterns because the public list carries
  // ":id" placeholders ("PUT /api/v1/agent/conversations/:id/restart").
  const publicPatterns = new Set<string>();
  for (const entry of PUBLIC_ROUTES) {
    const [method, routeUrl] = entry.split(" ");
    publicPatterns.add(`${method} ${toRegex(routeUrl).source}`);
  }
  const isPublic = (method: string, pathname: string) =>
    [...publicPatterns].some((entry) => {
      const [entryMethod, source] = entry.split(" ");
      return entryMethod === method && new RegExp(source).test(pathname);
    });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname.startsWith("/api/")) return;
    const isMultipart = (request.headers["content-type"] ?? "").includes("multipart/form-data");
    const contract = matchContract(request.method, pathname);

    // Public routes still validate their body — the target answers 422 to an
    // anonymous POST /auth/login with `{}`, before any credential check.
    if (isPublic(request.method, pathname)) {
      if (contract) {
        const issues = collectValidationErrors(contract, request.body, request.query, isMultipart);
        if (issues.length) return reply.code(422).send({ detail: issues });
      }
      return;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return reply.code(403).send(AUTH_MISSING);
    try { request.auth = auth.me(header.slice("Bearer ".length)); }
    catch { return reply.code(401).send(AUTH_INVALID); }
    request.authToken = header.slice("Bearer ".length);

    // Authenticated routes validate after auth, matching the target's order.
    if (contract) {
      const issues = collectValidationErrors(contract, request.body, request.query, isMultipart);
      if (issues.length) return reply.code(422).send({ detail: issues });
    }
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0];
    if (pathname.startsWith("/api/")) {
      const pathExists = routePatterns.some((r) => r.regex.test(pathname));
      return pathExists
        ? reply.code(405).send({ detail: "Method Not Allowed" })
        : reply.code(404).send({ detail: "Not Found" });
    }
    return reply.sendFile("index.html");
  });

  app.addHook("onClose", () => db.close());
  return app;
}

/** Pydantic's `loc` prefix per request part; Fastify calls them differently. */
const LOC_PREFIX: Record<string, string> = { querystring: "query", params: "path", body: "body" };

/** Map Ajv validation failures onto Pydantic's error list shape. */
function pydanticErrors(error: FastifyError) {
  const prefix = LOC_PREFIX[error.validationContext ?? "body"] ?? "body";
  return (error.validation ?? []).map((item) => {
    const loc = [prefix, ...item.instancePath.split("/").filter(Boolean)];
    if (item.keyword === "required") {
      const missing = item.params.missingProperty as string;
      return { type: "missing", loc: [...loc, missing], msg: "Field required", input: null };
    }
    if (item.keyword === "type") {
      const expected = item.params.type as string;
      return { type: `${expected}_type`, loc, msg: `Input should be a valid ${expected}` };
    }
    return { type: item.keyword, loc, msg: item.message ?? "Invalid value" };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer();
  app.listen({ host: config.host, port: config.port }).then(() => console.log(`local site listening on http://${config.host}:${config.port}`));
}
