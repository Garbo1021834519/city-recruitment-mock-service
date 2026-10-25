import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("phase-two agent and activation flows", () => {
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
  });
  afterAll(async () => { await app.close(); });

  it("creates a device and persists a manual reply", async () => {
    const device = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: { authorization: `Bearer ${token}` }, payload: { device_code: "D-1", device_name: "测试设备", status: "enabled" } });
    expect(device.statusCode).toBe(200);
    app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname) VALUES (?,?,?)").run("D-1", 7, "测试客户");
    const reply = await app.inject({ method: "POST", url: "/api/v1/agent/manual-reply", headers: { authorization: `Bearer ${token}` }, payload: { device_code: "D-1", customer_id: 7, content: "你好" } });
    expect(reply.statusCode).toBe(200);
    const messages = await app.inject({ method: "GET", url: "/api/v1/agent/messages?device_code=D-1&customer_id=7&after_id=0", headers: { authorization: `Bearer ${token}` } });
    expect(messages.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ content: "你好", direction: "outbound" })]));
  });

  it("moves an activation record through approval and sending", async () => {
    const db = (app as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("INSERT INTO activation_records(customer_id,nickname,status) VALUES (?,?,?)").run(9, "测试客户", "pending_review");
    const approved = await app.inject({ method: "POST", url: "/api/v1/activation/records/1/approve", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("pending_send");
    const sent = await app.inject({ method: "POST", url: "/api/v1/activation/records/1/run", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(sent.json().status).toBe("sent");
    expect(sent.json().tier).toBe(1);
  });
});
