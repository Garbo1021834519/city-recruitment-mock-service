import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("local agent conversation flow", () => {
  let app: FastifyInstance;
  let customerToken = "";

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    customerToken = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-customer", password: "local-demo-only" } })).json().access_token;
  });

  afterAll(async () => { await app.close(); });

  const headers = () => ({ authorization: `Bearer ${customerToken}` });

  it("seeds a stable device code and a conversation with matching messages", async () => {
    const devices = await app.inject({ method: "GET", url: "/api/v1/agent/devices?my=true", headers: headers() });
    expect(devices.statusCode).toBe(200);
    expect(devices.json().items).toEqual([expect.objectContaining({ device_code: "local-device-001", online: false })]);

    const conversations = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=local-device-001", headers: headers() });
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json()).toMatchObject({ items: [expect.objectContaining({ customer_id: 700001, nickname: "示例客户A" })] });

    const messages = await app.inject({ method: "GET", url: "/api/v1/agent/messages?device_code=local-device-001&customer_id=700001&after_id=0", headers: headers() });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "inbound", content: "想了解一下长白班岗位" }),
      expect.objectContaining({ direction: "outbound", content: "可以的，我先给你发几个示例岗位。" }),
    ]));
  });

  it("keeps the required device contract for a missing device code", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/agent/conversations?device_code=", headers: headers() });
    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toEqual(expect.arrayContaining([expect.objectContaining({ loc: ["query", "device_code"] })]));
  });
});
