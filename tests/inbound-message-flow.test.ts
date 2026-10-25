import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { type DifyMessageInput, type DifyMessageResult, type DifyProvider } from "../src/modules/dify/dify-provider.js";
import { MessageEventService } from "../src/modules/messaging/message-events.js";
import { MessageAutomationService } from "../src/modules/messaging/message-automation.js";
import { MockMessageChannelProvider } from "../src/modules/messaging/message-channel-provider.js";

describe("inbound message reply loop", () => {
  let app: FastifyInstance;
  const originalEnv = {
    databasePath: process.env.REA_DATABASE_PATH,
    webhookSecret: process.env.REA_WEBHOOK_SECRET,
    difyProvider: process.env.REA_DIFY_PROVIDER,
    channelProvider: process.env.REA_MESSAGE_CHANNEL_PROVIDER,
  };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_WEBHOOK_SECRET = "inbound-loop-test-secret";
    process.env.REA_DIFY_PROVIDER = "mock";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnv.databasePath === undefined) delete process.env.REA_DATABASE_PATH;
    else process.env.REA_DATABASE_PATH = originalEnv.databasePath;
    if (originalEnv.webhookSecret === undefined) delete process.env.REA_WEBHOOK_SECRET;
    else process.env.REA_WEBHOOK_SECRET = originalEnv.webhookSecret;
    if (originalEnv.difyProvider === undefined) delete process.env.REA_DIFY_PROVIDER;
    else process.env.REA_DIFY_PROVIDER = originalEnv.difyProvider;
    if (originalEnv.channelProvider === undefined) delete process.env.REA_MESSAGE_CHANNEL_PROVIDER;
    else process.env.REA_MESSAGE_CHANNEL_PROVIDER = originalEnv.channelProvider;
  });

  function signedRequest(id: string, content: string) {
    const payload = {
      id,
      event: "message.created",
      data: { device_code: "local-device-001", customer_id: 700001, content },
    };
    const rawBody = JSON.stringify(payload);
    const signature = createHmac("sha256", "inbound-loop-test-secret").update(rawBody).digest("hex");
    return app.inject({
      method: "POST",
      url: "/api/v1/webhooks/dify",
      headers: { "content-type": "application/json", "x-dify-signature": signature },
      payload,
    });
  }

  it("takes one signed inbound message through Dify and an outbound channel", async () => {
    const response = await signedRequest("loop-event-1", "请推荐一个岗位");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "processed", event_id: "loop-event-1", reply_status: "simulated" });
    expect(app.db.prepare("SELECT direction,content FROM agent_messages WHERE content='请推荐一个岗位'").get())
      .toMatchObject({ direction: "inbound", content: "请推荐一个岗位" });
    expect(app.db.prepare("SELECT direction,content,status FROM agent_messages WHERE device_code='local-device-001' AND customer_id=700001 ORDER BY id DESC LIMIT 1").get())
      .toMatchObject({ direction: "outbound", content: "Mock response for 700001", status: "simulated" });
    expect(app.db.prepare("SELECT status,attempts,provider_message_id FROM message_deliveries WHERE event_id='loop-event-1:reply'").get())
      .toMatchObject({ status: "succeeded", attempts: 1, provider_message_id: "mock-local-device-001-700001" });
    expect(app.db.prepare("SELECT last_msg,unread FROM agent_conversations WHERE device_code='local-device-001' AND customer_id=700001").get())
      .toMatchObject({ last_msg: "Mock response for 700001", unread: 2 });
  });

  it("does not create a second reply when the same webhook is retried", async () => {
    await signedRequest("loop-event-duplicate", "重复投递测试");
    const retry = await signedRequest("loop-event-duplicate", "重复投递测试");

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: "duplicate", event_id: "loop-event-duplicate" });
    expect(app.db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE content='重复投递测试'").get())
      .toMatchObject({ count: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS count FROM message_deliveries WHERE event_id='loop-event-duplicate:reply'").get())
      .toMatchObject({ count: 1 });
  });

  it("requires a valid webhook signature without requiring a user JWT", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/dify",
      headers: { "content-type": "application/json", "x-dify-signature": "invalid" },
      payload: { id: "bad-signature", event: "message.created", data: { device_code: "local-device-001", customer_id: 700001, content: "ignored" } },
    });

    expect(response.statusCode).toBe(401);
    expect(app.db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE content='ignored'").get()).toMatchObject({ count: 0 });
  });

  it("records inbound messages but does not auto-reply while a recruiter has taken over", async () => {
    app.db.prepare("UPDATE agent_conversations SET takeover=1 WHERE device_code=? AND customer_id=?").run("local-device-001", 700001);

    const response = await signedRequest("loop-event-takeover", "人工接管期间的消息");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "processed", reply_status: "human_takeover" });
    expect(app.db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE content='人工接管期间的消息'").get()).toMatchObject({ count: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS count FROM message_deliveries WHERE event_id='loop-event-takeover:reply'").get()).toMatchObject({ count: 0 });
  });

  it("retries a failed AI reply for the same signed webhook without duplicating the inbound message", async () => {
    let fail = true;
    const db = new DatabaseSync(":memory:");
    migrateDatabase(db);
    seedDatabase(db);
    const events = new MessageEventService(db, { webhookSecret: "inbound-loop-test-secret" });
    const provider: DifyProvider = {
      async sendMessage(_input: DifyMessageInput): Promise<DifyMessageResult> {
        if (fail) return { success: false, error: "temporary provider outage" };
        return { success: true, message: "Recovered mock reply", message_id: "recovered-1" };
      },
      async healthCheck() { return { healthy: true, latency_ms: 0 }; },
    };
    const automation = new MessageAutomationService(db, events, provider, new MockMessageChannelProvider());
    try {
      const input = { eventId: "retry-event-1", deviceCode: "local-device-001", customerId: 700001, content: "重试测试" };
      events.recordEvent({ eventId: input.eventId, eventType: "message.created", direction: "inbound", deviceCode: input.deviceCode, customerId: input.customerId, payload: { content: input.content } });
      await expect(automation.handleInbound(input)).resolves.toMatchObject({ reply_status: "failed" });
      fail = false;
      await expect(automation.handleInbound(input)).resolves.toMatchObject({ reply_status: "simulated" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE source_event_id=?").get(input.eventId)).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT status,attempts,content FROM message_deliveries WHERE event_id=?").get(`${input.eventId}:reply`))
        .toMatchObject({ status: "succeeded", attempts: 2, content: "Recovered mock reply" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE direction='outbound' AND content='Recovered mock reply'").get()).toMatchObject({ count: 1 });
    } finally {
      db.close();
    }
  });
});
