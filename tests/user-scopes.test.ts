import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("business scope enforcement", () => {
  let app: FastifyInstance;
  let adminToken = "";
  let customerToken = "";
  let recruiterToken = "";

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    adminToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    customerToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
    recruiterToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-recruiter", password: "local-demo-only" } })).json().access_token;
    app.db.prepare("INSERT INTO agent_devices(id,device_name,status,data_json) VALUES (2,'其他示例设备','enabled',?)").run(JSON.stringify({ device_code: "other-device", recruiter_id: "other-recruiter", workflow_file: "workflow.json" }));
    app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,nickname,city,last_msg) VALUES (?,?,?,?,?)").run("other-device", 700002, "其他客户", "深圳", "其他消息");
    app.db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content) VALUES (?,?,?,?)").run("other-device", 700002, "inbound", "其他消息");
  });

  afterAll(async () => { await app.close(); });

  const headers = (token: string) => ({ authorization: `Bearer ${token}` });

  it("gives admin a global view while customer and recruiter see only assigned cities/devices", async () => {
    const adminCities = await app.inject({ method: "GET", url: "/api/v1/cities?page=1&page_size=100", headers: headers(adminToken) });
    const customerCities = await app.inject({ method: "GET", url: "/api/v1/cities?page=1&page_size=100", headers: headers(customerToken) });
    const recruiterCities = await app.inject({ method: "GET", url: "/api/v1/cities?page=1&page_size=100", headers: headers(recruiterToken) });
    expect(adminCities.json().total).toBe(3);
    expect(customerCities.json().items).toEqual([expect.objectContaining({ id: 1, city_name: "广州" })]);
    expect(recruiterCities.json().items).toEqual([expect.objectContaining({ id: 1, city_name: "广州" })]);

    const adminDevices = await app.inject({ method: "GET", url: "/api/v1/agent/devices?my=true", headers: headers(adminToken) });
    const customerDevices = await app.inject({ method: "GET", url: "/api/v1/agent/devices?my=true", headers: headers(customerToken) });
    expect(adminDevices.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ device_code: "other-device" })]));
    expect(customerDevices.json().items).toEqual([expect.objectContaining({ device_code: "local-device-001" })]);
  });

  it("blocks guessed conversations outside the user's device scope", async () => {
    const own = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=local-device-001", headers: headers(customerToken) });
    expect(own.statusCode).toBe(200);
    expect(own.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ customer_id: 700001 })]));

    const outsider = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=other-device", headers: headers(customerToken) });
    expect(outsider.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/messages?device_code=other-device&customer_id=700002", headers: headers(customerToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=other-device", headers: headers(adminToken) })).statusCode).toBe(200);
  });

  it("does not expose an unassigned city or device by guessed detail ID", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/cities/2", headers: headers(customerToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/device/2/workflow", headers: headers(customerToken) })).json()).toMatchObject({ ok: false, message: "设备不存在" });
  });
});
