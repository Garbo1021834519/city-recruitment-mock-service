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
    app.db.prepare("INSERT INTO candidate_events(device_code,customer_id,nickname,event_type) VALUES (?,?,?,?)").run("other-device", "700002", "其他候选人", "invited");
    app.db.prepare("INSERT INTO activation_records(id,customer_id,device_code,status) VALUES (9901,700002,'other-device','pending_review')").run();
    app.db.prepare("INSERT INTO city_history(id,city_id,snapshot_json) VALUES (9901,2,'{}')").run();
    app.db.prepare("INSERT INTO recruiters(id,username,city_id,data_json) VALUES (2,'other-recruiter',2,?)").run(JSON.stringify({ recruiter_id: "other-recruiter" }));
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

    const adminDashboard = await app.inject({ method: "GET", url: "/api/v1/agent/status/dashboard", headers: headers(adminToken) });
    const customerDashboard = await app.inject({ method: "GET", url: "/api/v1/agent/status/dashboard", headers: headers(customerToken) });
    expect(adminDashboard.json().devices.total).toBe(2);
    expect(customerDashboard.json().devices.total).toBe(1);
    expect(adminDashboard.json().messages.total).toBe(3);
    expect(customerDashboard.json().messages.total).toBe(2);
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

  it("blocks a scoped user from restarting a conversation on another device", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/v1/agent/conversations/700002/restart?device_code=other-device", headers: headers(customerToken) });
    expect(response.statusCode).toBe(403);
  });

  it("does not expose an unassigned city or device by guessed detail ID", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/cities/2", headers: headers(customerToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/device/2/workflow", headers: headers(customerToken) })).json()).toMatchObject({ ok: false, message: "设备不存在" });
  });

  it("blocks city status changes outside the assigned city scope", async () => {
    const response = await app.inject({ method: "PATCH", url: "/api/v1/cities/2/status", headers: headers(customerToken), payload: { recruitment_status: "disabled" } });
    expect(response.statusCode).toBe(403);
    expect((app.db.prepare("SELECT recruitment_status FROM cities WHERE id=2").get() as { recruitment_status: string }).recruitment_status).toBe("enabled");
  });

  it("blocks candidate status changes outside the assigned device scope", async () => {
    const candidate = app.db.prepare("SELECT id FROM candidate_events WHERE device_code='other-device'").get() as { id: number };
    const response = await app.inject({ method: "POST", url: `/api/v1/agent/candidates/${candidate.id}/mark?device_code=other-device`, headers: headers(customerToken), payload: { status: "followed" } });
    expect(response.statusCode).toBe(404);
    expect((app.db.prepare("SELECT status FROM candidate_events WHERE id=?").get(candidate.id) as { status: string }).status).toBe("invited");
  });

  it("blocks activation actions outside the assigned device scope", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/activation/records/9901/approve", headers: headers(customerToken), payload: {} });
    expect(response.statusCode).toBe(404);
    expect((app.db.prepare("SELECT status FROM activation_records WHERE id=9901").get() as { status: string }).status).toBe("pending_review");
  });

  it("blocks guessed city history, restore, and recruiter relation routes", async () => {
    const authHeaders = headers(customerToken);
    expect((await app.inject({ method: "GET", url: "/api/v1/cities/2/history/9901", headers: authHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/cities/2/restore/9901", headers: authHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/recruiters/2/service-cities", headers: authHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/recruiters/2/service-cities/options", headers: authHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/service-positions/2/holidays", headers: authHeaders })).statusCode).toBe(404);
  });
});
