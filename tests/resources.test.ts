import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import type { DatabaseSync } from "node:sqlite";

describe("resource modules", () => {
  let app: FastifyInstance;
  let token = "";
  let customerToken = "";
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    customerToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
  });
  afterAll(async () => { await app.close(); });

  it("creates and lists knowledge records", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/knowledge", headers: { authorization: `Bearer ${token}` }, payload: { question: "测试知识", answer: "内容" } });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/knowledge?page=1&page_size=20", headers: { authorization: `Bearer ${token}` } });
    // Target list items expose `question`, not `title`:
    // id, question, keywords, is_active, sort_order, recruiter_id, updated_at
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ question: "测试知识" })]));
  });

  it("serializes recruiter rows through the public field contract", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/recruiters", headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    const item = list.json().items[0];
    expect(item).toMatchObject({ recruiter_id: "mock-recruiter", recruiter_type: "service", cities: expect.any(Array), city_count: expect.any(Number), password_set: expect.any(Boolean) });
    expect(item).not.toHaveProperty("username");
    expect(item).not.toHaveProperty("city_id");
    expect(item).not.toHaveProperty("data_json");
  });

  it("filters recruiters, knowledge, and holidays by the signed-in user's scopes", async () => {
    const db = (app as FastifyInstance & { db: DatabaseSync }).db;
    db.prepare("INSERT INTO recruiters(id,username,city_id,data_json) VALUES (2,'other-recruiter',2,?)").run(JSON.stringify({ recruiter_id: "other-recruiter", name: "其他招聘员" }));
    db.prepare("INSERT INTO knowledge_items(id,title,content,data_json) VALUES (9001,'我的知识','回答',?)").run(JSON.stringify({ question: "我的知识", recruiter_id: "mock-recruiter" }));
    db.prepare("INSERT INTO knowledge_items(id,title,content,data_json) VALUES (9002,'他人的知识','回答',?)").run(JSON.stringify({ question: "他人的知识", recruiter_id: "other-recruiter" }));
    db.prepare("INSERT INTO holiday_schedules(id,city_id,date,kind) VALUES (9001,1,'2026-01-01','holiday'),(9002,2,'2026-01-02','holiday')").run();

    const headers = { authorization: `Bearer ${customerToken}` };
    const recruiters = await app.inject({ method: "GET", url: "/api/v1/recruiters?page_size=100", headers });
    expect(recruiters.json().items).toEqual([expect.objectContaining({ recruiter_id: "mock-recruiter" })]);

    const knowledge = await app.inject({ method: "GET", url: "/api/v1/knowledge?page_size=100", headers });
    expect(knowledge.json().items).toEqual([expect.objectContaining({ question: "我的知识" })]);
    expect((await app.inject({ method: "GET", url: "/api/v1/knowledge/9002", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/v1/knowledge/9002", headers, payload: { question: "越权改写" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/knowledge", headers, payload: { question: "越权创建", answer: "回答", recruiter_id: "other-recruiter" } })).statusCode).toBe(403);

    const holidays = await app.inject({ method: "GET", url: "/api/v1/holiday-schedules?page_size=100", headers });
    expect(holidays.json().items).toEqual([expect.objectContaining({ id: 9001, city_id: 1 })]);
    expect((await app.inject({ method: "GET", url: "/api/v1/holiday-schedules/9002", headers })).statusCode).toBe(404);
    const batch = await app.inject({ method: "POST", url: "/api/v1/knowledge/batch/update", headers, payload: { ids: [9002], status: "disabled" } });
    expect(batch.json().updated).toBe(0);
    expect((db.prepare("SELECT status FROM knowledge_items WHERE id=9002").get() as { status: string }).status).toBe("enabled");
    const myCities = await app.inject({ method: "GET", url: "/api/v1/holiday-schedules/my-cities", headers });
    expect(myCities.json()).toMatchObject({ unlimited: false, cities: [expect.objectContaining({ city_name: "广州" })] });
  });
});
