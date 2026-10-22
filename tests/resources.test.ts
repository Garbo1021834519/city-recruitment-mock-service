import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("resource modules", () => {
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => { process.env.REA_DATABASE_PATH = ":memory:"; app = buildServer(); await app.ready(); token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token; });
  afterAll(async () => { await app.close(); });

  it("creates and lists knowledge records", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/knowledge", headers: { authorization: `Bearer ${token}` }, payload: { question: "测试知识", answer: "内容" } });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/knowledge?page=1&page_size=20", headers: { authorization: `Bearer ${token}` } });
    // Target list items expose `question`, not `title`:
    // id, question, keywords, is_active, sort_order, recruiter_id, updated_at
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ question: "测试知识" })]));
  });
});
