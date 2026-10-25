import type { FastifyInstance } from "fastify";
import { AuthService } from "./auth.service.js";
import { authPreHandler, rolePreHandler } from "./rbac.js";
import {
  AdminUserError,
  createAdminUser,
  disableAdminUser,
  listAdminUsers,
  listUserScopes,
  replaceUserScopes,
  resetAdminUserPassword,
  updateAdminUser,
} from "./admin-users.js";

const adminOnly = (service: AuthService) => [authPreHandler(service), rolePreHandler("admin")];

function sendAdminUserError(error: unknown, reply: import("fastify").FastifyReply) {
  if (error instanceof AdminUserError) return reply.code(error.statusCode).send({ detail: error.message });
  if (error instanceof Error && /UNIQUE constraint failed: users\.username/.test(error.message)) return reply.code(409).send({ detail: "Username already exists" });
  throw error;
}

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

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/auth/users", { preHandler: adminOnly(service) }, (request, reply) => {
    const db = request.server.db;
    try { return listAdminUsers(db, request.query); }
    catch (error) { return sendAdminUserError(error, reply); }
  });

  app.post<{ Body: Record<string, unknown> }>("/api/v1/auth/users", { preHandler: adminOnly(service) }, (request, reply) => {
    try { return createAdminUser(request.server.db, request.auth!.id, request.body ?? {}); }
    catch (error) { return sendAdminUserError(error, reply); }
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v1/auth/users/:id", { preHandler: adminOnly(service) }, (request, reply) => {
    try { return updateAdminUser(request.server.db, request.auth!.id, Number(request.params.id), request.body ?? {}); }
    catch (error) { return sendAdminUserError(error, reply); }
  });

  app.get<{ Params: { id: string } }>("/api/v1/auth/users/:id/scopes", { preHandler: adminOnly(service) }, (request, reply) => {
    try { return { scopes: listUserScopes(request.server.db, Number(request.params.id)) }; }
    catch (error) { return sendAdminUserError(error, reply); }
  });

  app.put<{ Params: { id: string }; Body: { scopes?: Array<{ type: "recruiter" | "city" | "device"; id: string }> } }>("/api/v1/auth/users/:id/scopes", { preHandler: adminOnly(service) }, (request, reply) => {
    try { return { scopes: replaceUserScopes(request.server.db, Number(request.params.id), request.body?.scopes ?? []) }; }
    catch (error) { return sendAdminUserError(error, reply); }
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/v1/auth/users/:id/reset-password", { preHandler: adminOnly(service) }, (request, reply) => {
    try {
      if (typeof request.body?.password !== "string") throw new AdminUserError(422, "password is required");
      resetAdminUserPassword(request.server.db, request.auth!.id, Number(request.params.id), request.body.password);
      return { success: true };
    } catch (error) { return sendAdminUserError(error, reply); }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/auth/users/:id", { preHandler: adminOnly(service) }, (request, reply) => {
    try {
      disableAdminUser(request.server.db, request.auth!.id, Number(request.params.id));
      return { success: true };
    } catch (error) { return sendAdminUserError(error, reply); }
  });
}
