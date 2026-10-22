import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("generic API contract coverage", () => {
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => { process.env.REA_DATABASE_PATH = ":memory:"; app = buildServer(); await app.ready(); token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token; });
  afterAll(async () => { await app.close(); });
  it("serves settings, knowledge, activation and agent list contracts", async () => {
    for (const url of ["/api/v1/settings", "/api/v1/knowledge", "/api/v1/activation/dashboard/stats", "/api/v1/agent/devices"]) {
      const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200);
    }
  });
});
