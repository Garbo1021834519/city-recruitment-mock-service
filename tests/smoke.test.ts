import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("local static shell", () => {
  let app: FastifyInstance;
  beforeAll(async () => { process.env.REA_DATABASE_PATH = ":memory:"; app = buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it.each(["/login", "/cities", "/m", "/service-positions"]) ("serves SPA shell for %s", async (route) => {
    const response = await app.inject({ method: "GET", url: route });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("城市招聘配置管理");
  });

  it("serves the captured root JavaScript bundle", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/index-BGyFQL9Q.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.body).toContain("LoginView-C_4Zg0lI.js");
  });
});
