import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthService, type AuthUser } from "./auth.service.js";

declare module "fastify" { interface FastifyRequest { auth?: AuthUser } }

/**
 * Error bodies mirror the target's FastAPI/HTTPBearer semantics:
 *   missing Authorization      -> 403 {"detail":"Not authenticated"}
 *   present but unverifiable   -> 401 {"detail":"Invalid or expired token"}
 * The target distinguishes these two cases, so collapsing both into 401 is a parity bug.
 */
export const AUTH_MISSING = { detail: "Not authenticated" } as const;
export const AUTH_INVALID = { detail: "Invalid or expired token" } as const;

export function authPreHandler(service: AuthService) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return reply.code(403).send(AUTH_MISSING);
    try { request.auth = service.me(header.slice("Bearer ".length)); }
    catch { return reply.code(401).send(AUTH_INVALID); }
  };
}

export function rolePreHandler(...roles: AuthUser["role"][]) {
  return rolePreHandlerWithDetail(roles);
}

/**
 * The target returns route-specific 403 messages ("Admin access required",
 * "主推设置仅对招聘员账号开放"), so the message is a parameter, not a constant.
 */
export function rolePreHandlerWithDetail(roles: AuthUser["role"][], detail = "Insufficient permissions") {
  return async function requireRole(request: FastifyRequest, reply: FastifyReply) {
    if (!request.auth || !roles.includes(request.auth.role)) return reply.code(403).send({ detail });
  };
}
