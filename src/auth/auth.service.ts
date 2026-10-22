import { scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import jwt from "jsonwebtoken";

export interface AuthUser { id: number; username: string; role: "admin" | "customer" | "recruiter"; recruiter_id: string; recruiter_type: string }
export interface LoginResult { access_token: string; token_type: "bearer" }

function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBytes = Buffer.from(expected, "hex");
  return expectedBytes.length === actual.length && timingSafeEqual(actual, expectedBytes);
}

export class AuthService {
  constructor(private readonly db: DatabaseSync, private readonly secret: string) {}

  login(username: string, password: string): LoginResult {
    const user = this.db.prepare("SELECT * FROM users WHERE username=? AND is_active=1").get(username) as Record<string, unknown> | undefined;
    if (!user || !verifyPassword(password, String(user.password_hash))) throw new Error("用户名或密码错误");
    const payload = { sub: String(user.id), username: String(user.username), role: String(user.role) };
    return { access_token: jwt.sign(payload, this.secret, { expiresIn: "8h" }), token_type: "bearer" };
  }

  me(token: string): AuthUser {
    const payload = jwt.verify(token, this.secret) as { sub: string; username: string; role: AuthUser["role"] };
    const user = this.db.prepare("SELECT id,username,role,recruiter_id,recruiter_type FROM users WHERE id=? AND is_active=1").get(Number(payload.sub)) as Record<string, unknown> | undefined;
    if (!user) throw new Error("用户不存在");
    return { id: Number(user.id), username: String(user.username), role: user.role as AuthUser["role"], recruiter_id: String(user.recruiter_id ?? ""), recruiter_type: String(user.recruiter_type ?? "") };
  }

  authorize(token: string, roles: AuthUser["role"][]): boolean {
    try { return roles.includes(this.me(token).role); } catch { return false; }
  }
}
