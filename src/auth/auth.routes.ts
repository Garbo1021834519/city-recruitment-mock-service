import type { FastifyInstance } from "fastify";
import { AuthService } from "./auth.service.js";
import { authPreHandler, rolePreHandler } from "./rbac.js";

/**
 * FastAPI/Pydantic request-body schema for POST /auth/login.
 *
 * Declared as a Fastify route schema so validation runs BEFORE the auth
 * preHandler and before the handler, matching the target's middleware order:
 * an unauthenticated caller sending an empty body gets 422, not 403.
 * The 422 body shape is produced by the error handler in server.ts.
 */
export const loginSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: { type: "string" },
      password: { type: "string" },
    },
  },
} as const;

export async function registerAuthRoutes(app: FastifyInstance, service: AuthService) {
  app.post<{ Body: { username: string; password: string } }>("/api/v1/auth/login", { schema: loginSchema }, async (request, reply) => {
    try { return service.login(request.body.username, request.body.password); }
    catch { return reply.code(401).send({ detail: "Invalid username or password" }); }
  });

  // Target /auth/me is exactly {username, role, recruiter_id, recruiter_type};
  // the local user id is an internal field and must not leak into the response.
  app.get("/api/v1/auth/me", { preHandler: authPreHandler(service) }, (request) => {
    const { id: _id, ...publicUser } = request.auth!;
    return publicUser;
  });

  app.get("/api/v1/auth/users", { preHandler: [authPreHandler(service), rolePreHandler("admin")] }, (request) => {
    const db = request.server.db;
    const rows = db.prepare("SELECT id,username,role,recruiter_id,recruiter_type,is_active,created_at,updated_at FROM users ORDER BY id").all();
    return { items: rows, total: rows.length };
  });

  app.post<{ Body: { username: string; password: string; role?: "admin" | "customer" | "recruiter" } }>("/api/v1/auth/users", { preHandler: [authPreHandler(service), rolePreHandler("admin")] }, async (request, reply) => {
    const db = request.server.db;
    const { hashPassword } = await import("../db/seed.js");
    try {
      const result = db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,?,?)").run(request.body.username, hashPassword(request.body.password), request.body.role ?? "customer");
      return db.prepare("SELECT id,username,role,recruiter_id,recruiter_type,is_active FROM users WHERE id=?").get(Number(result.lastInsertRowid));
    } catch { return reply.code(409).send({ detail: "Username already exists" }); }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/auth/users/:id", { preHandler: [authPreHandler(service), rolePreHandler("admin")] }, (request, reply) => {
    const db = request.server.db;
    const result = db.prepare("UPDATE users SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(Number(request.params.id));
    return result.changes ? { success: true } : reply.code(404).send({ detail: "User not found" });
  });
}
