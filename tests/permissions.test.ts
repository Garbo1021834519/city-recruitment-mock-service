import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("observed role boundaries", () => {
  let app: FastifyInstance;
  beforeAll(async () => { process.env.REA_DATABASE_PATH = ":memory:"; app = buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });
  async function token(username: string) { return (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } })).json().access_token; }
  it("keeps users admin-only and recruiter-featured recruiter-only", async () => {
    const admin = await token("local-admin");
    const customer = await token("local-customer");
    const recruiter = await token("local-recruiter");
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: { authorization: `Bearer ${customer}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/recruiter-featured/cities", headers: { authorization: `Bearer ${customer}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/recruiter-featured/cities", headers: { authorization: `Bearer ${recruiter}` } })).statusCode).toBe(200);
  });

  it("keeps system settings, including provider credentials, admin-only", async () => {
    const admin = await token("local-admin");
    const customer = await token("local-customer");
    const headers = { authorization: `Bearer ${customer}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/settings", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/v1/settings", headers, payload: { dedup_llm_api_key: "attacker-value" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/settings", headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(200);
  });

  it("keeps global activation configuration writes admin-only", async () => {
    const customer = await token("local-customer");
    const headers = { authorization: `Bearer ${customer}` };
    expect((await app.inject({ method: "PUT", url: "/api/v1/activation/config", headers, payload: { paused: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/v1/activation/config/paused", headers, payload: { paused: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/v1/activation/strategies/no_reply", headers, payload: { enabled: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/activation/scripts", headers, payload: { content: "越权配置" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/reminder-config", headers, payload: { recruiter_id: "global", enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/followup-config", headers, payload: { recruiter_id: "global", enabled: true } })).statusCode).toBe(403);
  });
});
