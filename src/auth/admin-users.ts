import type { DatabaseSync } from "node:sqlite";
import { hashPassword } from "../db/seed.js";
import { parsePagination } from "../shared/pagination.js";

export type ScopeType = "recruiter" | "city" | "device";
export interface ScopeInput { type: ScopeType; id: string }
export interface UserListQuery extends Record<string, unknown> {
  search?: string;
  role?: string;
  is_active?: string | boolean;
  page?: string;
  page_size?: string;
}

export class AdminUserError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

type RecruiterRow = { id: number; username: string; data_json: string };

function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function findRecruiter(db: DatabaseSync, identifier: string): RecruiterRow | undefined {
  const byUsername = db.prepare("SELECT id,username,data_json FROM recruiters WHERE username=?").get(identifier) as RecruiterRow | undefined;
  if (byUsername) return byUsername;
  const byPublicId = db.prepare("SELECT id,username,data_json FROM recruiters WHERE json_extract(data_json,'$.recruiter_id')=?").get(identifier) as RecruiterRow | undefined;
  if (byPublicId) return byPublicId;
  return db.prepare("SELECT id,username,data_json FROM recruiters WHERE CAST(id AS TEXT)=?").get(identifier) as RecruiterRow | undefined;
}

function recruiterPublicId(row: RecruiterRow): string {
  const data = parseObject(row.data_json);
  return String(data.recruiter_id ?? row.username ?? row.id);
}

export function validateRecruiterId(db: DatabaseSync, identifier: string): string {
  const row = findRecruiter(db, identifier);
  if (!row) throw new AdminUserError(422, "Recruiter not found");
  return recruiterPublicId(row);
}

function normalizeScope(db: DatabaseSync, scope: ScopeInput): ScopeInput {
  if (!scope || typeof scope.type !== "string" || typeof scope.id !== "string" || !scope.id.trim()) {
    throw new AdminUserError(422, "Invalid user scope");
  }
  const id = scope.id.trim();
  if (scope.type === "recruiter") return { type: "recruiter", id: validateRecruiterId(db, id) };
  if (scope.type === "city") {
    const cityId = Number(id);
    if (!Number.isSafeInteger(cityId) || cityId <= 0 || !db.prepare("SELECT id FROM cities WHERE id=?").get(cityId)) {
      throw new AdminUserError(422, "City scope not found");
    }
    return { type: "city", id: String(cityId) };
  }
  if (scope.type === "device") {
    const exists = db.prepare("SELECT 1 FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?").get(id);
    if (!exists) throw new AdminUserError(422, "Device scope not found");
    return { type: "device", id };
  }
  throw new AdminUserError(422, "Unsupported user scope type");
}

function withTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function replaceUserScopes(db: DatabaseSync, userId: number, scopes: ScopeInput[]): ScopeInput[] {
  if (!Array.isArray(scopes)) throw new AdminUserError(422, "scopes must be an array");
  const normalized = scopes.map((scope) => normalizeScope(db, scope));
  const unique = [...new Map(normalized.map((scope) => [`${scope.type}:${scope.id}`, scope])).values()];
  withTransaction(db, () => {
    if (!db.prepare("SELECT id FROM users WHERE id=?").get(userId)) throw new AdminUserError(404, "User not found");
    db.prepare("DELETE FROM user_scope_assignments WHERE user_id=?").run(userId);
    const insert = db.prepare("INSERT INTO user_scope_assignments(user_id,scope_type,scope_id) VALUES (?,?,?)");
    for (const scope of unique) insert.run(userId, scope.type, scope.id);
  });
  return unique;
}

export function listUserScopes(db: DatabaseSync, userId: number): ScopeInput[] {
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(userId)) throw new AdminUserError(404, "User not found");
  return db.prepare("SELECT scope_type AS type,scope_id AS id FROM user_scope_assignments WHERE user_id=? ORDER BY scope_type,scope_id").all(userId) as unknown as ScopeInput[];
}

export function listAdminUsers(db: DatabaseSync, query: UserListQuery) {
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  if (typeof query.search === "string" && query.search.trim()) {
    conditions.push("(username LIKE ? COLLATE NOCASE OR recruiter_id LIKE ? COLLATE NOCASE)");
    const term = `%${query.search.trim()}%`;
    args.push(term, term);
  }
  if (typeof query.role === "string" && query.role) {
    if (!["admin", "customer", "recruiter"].includes(query.role)) throw new AdminUserError(422, "Invalid role filter");
    conditions.push("role=?");
    args.push(query.role);
  }
  if (query.is_active !== undefined && query.is_active !== "") {
    const value = query.is_active === true || query.is_active === "true" || query.is_active === "1" ? 1
      : query.is_active === false || query.is_active === "false" || query.is_active === "0" ? 0 : null;
    if (value === null) throw new AdminUserError(422, "is_active must be true or false");
    conditions.push("is_active=?");
    args.push(value);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM users${where}`).get(...args) as { count: number }).count);
  const hasPagination = query.page !== undefined || query.page_size !== undefined;
  const { page, pageSize, offset } = parsePagination(query);
  const limit = hasPagination ? pageSize : 1000;
  const rows = db.prepare(`SELECT id,username,role,recruiter_id,recruiter_type,is_active,created_at,updated_at FROM users${where} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...args, limit, hasPagination ? offset : 0);
  return { items: rows, total, ...(hasPagination ? { page, page_size: pageSize } : {}) };
}

export function writeAdminAudit(db: DatabaseSync, actorUserId: number, action: string, resourceType: string, resourceId: string, summary: Record<string, unknown>): void {
  db.prepare("INSERT INTO admin_audit_logs(actor_user_id,action,resource_type,resource_id,summary_json) VALUES (?,?,?,?,?)")
    .run(actorUserId, action, resourceType, resourceId, JSON.stringify(summary));
}

export function createAdminUser(db: DatabaseSync, actorUserId: number, body: Record<string, unknown>) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role = typeof body.role === "string" ? body.role : "customer";
  const rawRecruiterId = typeof body.recruiter_id === "string" ? body.recruiter_id.trim() : "";
  const recruiterType = typeof body.recruiter_type === "string" ? body.recruiter_type : "";
  if (!username || !password) throw new AdminUserError(422, "username and password are required");
  if (!["admin", "customer", "recruiter"].includes(role)) throw new AdminUserError(422, "Invalid role");
  if (role !== "admin" && !rawRecruiterId && (!Array.isArray(body.scopes) || body.scopes.length === 0)) throw new AdminUserError(422, "A recruiter or business scope is required");
  const recruiterId = rawRecruiterId ? validateRecruiterId(db, rawRecruiterId) : "";
  const scopes = Array.isArray(body.scopes) ? body.scopes as ScopeInput[] : [];
  const finalScopes = [...scopes, ...(recruiterId ? [{ type: "recruiter" as const, id: recruiterId }] : [])];

  try {
    return withTransaction(db, () => {
      const result = db.prepare("INSERT INTO users(username,password_hash,role,recruiter_id,recruiter_type) VALUES (?,?,?,?,?)")
        .run(username, hashPassword(password), role, recruiterId, recruiterType);
      const id = Number(result.lastInsertRowid);
      if (finalScopes.length) {
        const normalized = finalScopes.map((scope) => normalizeScope(db, scope));
        const insert = db.prepare("INSERT OR IGNORE INTO user_scope_assignments(user_id,scope_type,scope_id) VALUES (?,?,?)");
        for (const scope of normalized) insert.run(id, scope.type, scope.id);
      }
      writeAdminAudit(db, actorUserId, "user.created", "user", String(id), { fields: ["username", "role", "recruiter_id", "recruiter_type"], scope_count: finalScopes.length });
      return db.prepare("SELECT id,username,role,recruiter_id,recruiter_type,is_active,created_at,updated_at FROM users WHERE id=?").get(id);
    });
  } catch (error) {
    if (error instanceof AdminUserError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed: users\.username/.test(error.message)) throw new AdminUserError(409, "Username already exists");
    throw error;
  }
}

export function updateAdminUser(db: DatabaseSync, actorUserId: number, targetId: number, body: Record<string, unknown>) {
  return withTransaction(db, () => {
    const current = db.prepare("SELECT id,username,role,recruiter_id,recruiter_type,is_active FROM users WHERE id=?").get(targetId) as Record<string, unknown> | undefined;
    if (!current) throw new AdminUserError(404, "User not found");
    const nextRole = typeof body.role === "string" ? body.role : String(current.role);
    if (!["admin", "customer", "recruiter"].includes(nextRole)) throw new AdminUserError(422, "Invalid role");
    const nextRecruiterRaw = typeof body.recruiter_id === "string" ? body.recruiter_id.trim() : String(current.recruiter_id ?? "");
    const nextRecruiterId = nextRecruiterRaw ? validateRecruiterId(db, nextRecruiterRaw) : "";
    const nextRecruiterType = typeof body.recruiter_type === "string" ? body.recruiter_type : String(current.recruiter_type ?? "");
    const nextActive = typeof body.is_active === "boolean" ? Number(body.is_active) : Number(current.is_active);
    if (Number(current.id) === actorUserId && (nextActive === 0 || nextRole !== "admin")) throw new AdminUserError(409, "You cannot disable or demote your own admin account");
    if (current.role === "admin" && (nextRole !== "admin" || nextActive === 0)) {
      const admins = Number((db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND is_active=1").get() as { count: number }).count);
      if (admins <= 1) throw new AdminUserError(409, "Cannot disable or demote the last active administrator");
    }
    if (nextRole !== "admin" && !nextRecruiterId && listUserScopes(db, targetId).length === 0) throw new AdminUserError(422, "A recruiter or business scope is required");
    db.prepare("UPDATE users SET role=?,recruiter_id=?,recruiter_type=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(nextRole, nextRecruiterId, nextRecruiterType, nextActive, targetId);
    if (nextRecruiterId) {
      const exists = db.prepare("SELECT 1 FROM user_scope_assignments WHERE user_id=? AND scope_type='recruiter' AND scope_id=?").get(targetId, nextRecruiterId);
      if (!exists) db.prepare("INSERT INTO user_scope_assignments(user_id,scope_type,scope_id) VALUES (?, 'recruiter', ?)").run(targetId, nextRecruiterId);
    }
    const fields = Object.keys(body).filter((field) => ["role", "recruiter_id", "recruiter_type", "is_active"].includes(field));
    writeAdminAudit(db, actorUserId, "user.updated", "user", String(targetId), { fields });
    return db.prepare("SELECT id,username,role,recruiter_id,recruiter_type,is_active,created_at,updated_at FROM users WHERE id=?").get(targetId);
  });
}

export function resetAdminUserPassword(db: DatabaseSync, actorUserId: number, targetId: number, password: string): void {
  if (password.length < 8) throw new AdminUserError(422, "Password must be at least 8 characters");
  const result = db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hashPassword(password), targetId);
  if (result.changes !== 1) throw new AdminUserError(404, "User not found");
  writeAdminAudit(db, actorUserId, "user.password_reset", "user", String(targetId), { fields: ["password_hash"] });
}

export function disableAdminUser(db: DatabaseSync, actorUserId: number, targetId: number): void {
  const target = db.prepare("SELECT id,role,is_active FROM users WHERE id=?").get(targetId) as { id: number; role: string; is_active: number } | undefined;
  if (!target) throw new AdminUserError(404, "User not found");
  if (targetId === actorUserId) throw new AdminUserError(409, "You cannot disable your own admin account");
  if (target.role === "admin" && target.is_active) {
    const admins = Number((db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND is_active=1").get() as { count: number }).count);
    if (admins <= 1) throw new AdminUserError(409, "Cannot disable the last active administrator");
  }
  const result = db.prepare("UPDATE users SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND is_active=1").run(targetId);
  if (result.changes) writeAdminAudit(db, actorUserId, "user.disabled", "user", String(targetId), { fields: ["is_active"] });
}
