import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("admin operations overview", () => {
  let app: FastifyInstance;
  let adminToken = "";
  let customerToken = "";

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    adminToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    customerToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
  });

  afterAll(async () => { await app.close(); });

  it("returns aggregate counts and no raw business content to admin", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { authorization: `Bearer ${adminToken}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total_users: 3,
      active_users: 3,
      admins: 1,
      customers: 1,
      recruiters: 1,
      cities: 3,
      positions: 2,
      devices: 1,
      conversations: 1,
      pending_activations: expect.any(Number),
      retry_jobs: expect.any(Number),
      dead_jobs: expect.any(Number),
      rejected_webhooks: expect.any(Number),
    });
    expect(response.json()).not.toHaveProperty("messages");
    expect(response.json()).not.toHaveProperty("candidates");
  });

  it("rejects non-admin overview access", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { authorization: `Bearer ${customerToken}` } })).statusCode).toBe(403);
  });
});
