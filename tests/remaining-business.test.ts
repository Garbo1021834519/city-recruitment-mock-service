import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("remaining business workflows", () => {
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => { process.env.REA_DATABASE_PATH = ":memory:"; app = buildServer(); await app.ready(); token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token; });
  afterAll(async () => { await app.close(); });

  it("persists reminder and follow-up rules", async () => {
    const save = await app.inject({ method: "POST", url: "/api/v1/agent/reminder-config", headers: { authorization: `Bearer ${token}` }, payload: { recruiter_id: "global", enabled: true, advance_hours: 4, fixed_time: "10:00", script: "请回复" } });
    expect(save.json()).toMatchObject({ enabled: true, advance_hours: 4 });
    const read = await app.inject({ method: "GET", url: "/api/v1/agent/reminder-config", headers: { authorization: `Bearer ${token}` } });
    expect(read.json()).toMatchObject({ enabled: true, advance_hours: 4 });
  });

  it("returns candidate records and updates candidate marks", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/agent/candidates", headers: { authorization: `Bearer ${token}` }, payload: { customer_id: "c-1", nickname: "候选人A", event_type: "invited", city: "广州" } });
    expect(created.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/agent/candidates?event_type=invited&page=1&page_size=50", headers: { authorization: `Bearer ${token}` } });
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ nickname: "候选人A", status: "invited" })]));
    expect(list.json().items[0]).toHaveProperty("wechat_id");
    expect(list.json().items[0]).not.toHaveProperty("data_json");
    expect(list.json().items[0]).not.toHaveProperty("updated_at");
    const marked = await app.inject({ method: "POST", url: `/api/v1/agent/candidates/${created.json().id}/mark?device_code=D-1`, headers: { authorization: `Bearer ${token}` }, payload: { status: "followed" } });
    expect(marked.json().status).toBe("followed");
  });

  it("returns real strategy, script, evaluation and account summary shapes", async () => {
    const strategies = await app.inject({ method: "GET", url: "/api/v1/activation/strategies", headers: { authorization: `Bearer ${token}` } });
    expect(strategies.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ code: "no_reply", enabled: true })]), engine: expect.objectContaining({ freeze_days: 14 }) });
    const scripts = await app.inject({ method: "GET", url: "/api/v1/activation/scripts?page=1&page_size=20", headers: { authorization: `Bearer ${token}` } });
    expect(scripts.json()).toMatchObject({ active_total: expect.any(Number), categories: expect.any(Array) });
    const evals = await app.inject({ method: "GET", url: "/api/v1/agent/evaluation/overview?days=7", headers: { authorization: `Bearer ${token}` } });
    expect(evals.json()).toHaveProperty("days");
    const report = await app.inject({ method: "GET", url: "/api/v1/agent/report/account-summary?prefix=local", headers: { authorization: `Bearer ${token}` } });
    expect(report.json()).toHaveProperty("date_range");
    const dashboard = await app.inject({ method: "GET", url: "/api/v1/agent/status/dashboard", headers: { authorization: `Bearer ${token}` } });
    expect(dashboard.json().state_distribution).toMatchObject({ active: expect.any(Number), disqualified: expect.any(Number), waiting: expect.any(Number) });
    const metrics = await app.inject({ method: "GET", url: "/api/v1/agent/report/metrics", headers: { authorization: `Bearer ${token}` } });
    expect(metrics.json()).toMatchObject({ start_date: expect.any(String), end_date: expect.any(String), items: expect.any(Array) });
  });
});
