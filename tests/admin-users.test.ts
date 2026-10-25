import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("admin user lifecycle", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let customerToken: string;

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    adminToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    customerToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
  });

  afterAll(async () => { await app.close(); });

  const adminHeaders = () => ({ authorization: `Bearer ${adminToken}` });

  async function createUser(username: string, extra: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url: "/api/v1/auth/users", headers: adminHeaders(), payload: { username, password: "initial-password", role: "customer", recruiter_id: "mock-recruiter", recruiter_type: "service", ...extra } });
  }

  it("creates a scoped recruiter account and filters the account list", async () => {
    const created = await createUser("ops-recruiter", {
      role: "recruiter",
      recruiter_id: "mock-recruiter",
      recruiter_type: "service",
      scopes: [{ type: "city", id: "1" }],
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ username: "ops-recruiter", role: "recruiter", recruiter_id: "mock-recruiter", recruiter_type: "service" });
    expect(created.json()).not.toHaveProperty("password_hash");

    const stored = app.db.prepare("SELECT recruiter_id,recruiter_type FROM users WHERE username=?").get("ops-recruiter");
    expect(stored).toMatchObject({ recruiter_id: "mock-recruiter", recruiter_type: "service" });
    expect(app.db.prepare("SELECT scope_type,scope_id FROM user_scope_assignments WHERE user_id=?").get(created.json().id)).toMatchObject({ scope_type: "city", scope_id: "1" });

    const filtered = await app.inject({ method: "GET", url: "/api/v1/auth/users?role=recruiter&search=ops&page=1&page_size=1", headers: adminHeaders() });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({ total: 1, items: [{ username: "ops-recruiter", role: "recruiter" }] });
  });

  it("edits account role and scope, then permits reactivation", async () => {
    const created = await createUser("editable-account");
    const id = created.json().id as number;
    const updated = await app.inject({ method: "PUT", url: `/api/v1/auth/users/${id}`, headers: adminHeaders(), payload: { role: "recruiter", recruiter_id: "mock-recruiter", recruiter_type: "service", is_active: true } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ role: "recruiter", recruiter_id: "mock-recruiter", recruiter_type: "service", is_active: 1 });

    const scopeResult = await app.inject({ method: "PUT", url: `/api/v1/auth/users/${id}/scopes`, headers: adminHeaders(), payload: { scopes: [{ type: "city", id: "2" }] } });
    expect(scopeResult.statusCode).toBe(200);
    expect(scopeResult.json()).toMatchObject({ scopes: [{ type: "city", id: "2" }] });

    await app.inject({ method: "DELETE", url: `/api/v1/auth/users/${id}`, headers: adminHeaders() });
    const reactivated = await app.inject({ method: "PUT", url: `/api/v1/auth/users/${id}`, headers: adminHeaders(), payload: { is_active: true } });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().is_active).toBe(1);
  });

  it("resets a user's password and writes a redacted audit record", async () => {
    const created = await createUser("password-reset-user");
    const id = created.json().id as number;
    const reset = await app.inject({ method: "POST", url: `/api/v1/auth/users/${id}/reset-password`, headers: adminHeaders(), payload: { password: "new-password-value" } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ success: true });

    const oldLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "password-reset-user", password: "initial-password" } });
    const newLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "password-reset-user", password: "new-password-value" } });
    expect(oldLogin.statusCode).toBe(401);
    expect(newLogin.statusCode).toBe(200);

    const audit = app.db.prepare("SELECT action,summary_json FROM admin_audit_logs WHERE resource_id=? ORDER BY id DESC").all(String(id)) as Array<{ action: string; summary_json: string }>;
    expect(audit.map((row) => row.action)).toContain("user.password_reset");
    expect(audit.map((row) => row.summary_json).join(" ")).not.toContain("new-password-value");
  });

  it("rejects invalid recruiter references and non-admin mutations", async () => {
    const invalid = await createUser("invalid-recruiter", { role: "recruiter", recruiter_id: "missing-recruiter" });
    expect(invalid.statusCode).toBe(422);

    const denied = await app.inject({ method: "POST", url: "/api/v1/auth/users", headers: { authorization: `Bearer ${customerToken}` }, payload: { username: "forbidden", password: "password" } });
    expect(denied.statusCode).toBe(403);

    const created = await createUser("scope-validation-user");
    const badScope = await app.inject({ method: "PUT", url: `/api/v1/auth/users/${created.json().id}/scopes`, headers: adminHeaders(), payload: { scopes: [{ type: "city", id: "999999" }] } });
    expect(badScope.statusCode).toBe(422);
  });

  it("does not allow an administrator to disable itself or the last active administrator", async () => {
    const listed = await app.inject({ method: "GET", url: "/api/v1/auth/users?search=local-admin", headers: adminHeaders() });
    const adminId = listed.json().items[0].id as number;
    const selfDisable = await app.inject({ method: "DELETE", url: `/api/v1/auth/users/${adminId}`, headers: adminHeaders() });
    expect(selfDisable.statusCode).toBe(409);

    const selfRoleChange = await app.inject({ method: "PUT", url: `/api/v1/auth/users/${adminId}`, headers: adminHeaders(), payload: { role: "customer" } });
    expect(selfRoleChange.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: adminHeaders() })).statusCode).toBe(200);
  });
});
