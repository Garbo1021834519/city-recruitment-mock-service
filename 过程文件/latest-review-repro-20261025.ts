// Read-only review of production source. Uses only disposable in-memory databases.
// Run from repository root: node --import tsx 过程文件/latest-review-repro-20261025.ts
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { buildServer } from "../src/server.js";
import { MessageEventService } from "../src/modules/messaging/message-events.js";
import { MessageAutomationService } from "../src/modules/messaging/message-automation.js";
import { MockDifyProvider, type DifyMessageInput, type DifyMessageResult, type DifyProvider } from "../src/modules/dify/dify-provider.js";
import { MockMessageChannelProvider } from "../src/modules/messaging/message-channel-provider.js";

const evidence: Record<string, unknown> = {};
function setup(provider: DifyProvider = new MockDifyProvider()) {
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db); seedDatabase(db);
  const events = new MessageEventService(db, { webhookSecret: "review-only" });
  const channel = new MockMessageChannelProvider();
  const service = new MessageAutomationService(db, events, provider, channel);
  return { db, events, service };
}
const input = (eventId: string, content = eventId) => ({ eventId, deviceCode: "local-device-001", customerId: 700001, content });
const healthCheck = async () => ({ healthy: true, latency_ms: 0 });

// A recruiter takes over while an already-started AI generation is waiting.
{
  let resolve!: (value: DifyMessageResult) => void;
  const provider: DifyProvider = { sendMessage: () => new Promise(r => { resolve = r; }), healthCheck };
  const { db, service } = setup(provider);
  const pending = service.handleInbound(input("review-takeover"));
  db.prepare("UPDATE agent_conversations SET takeover=1 WHERE customer_id=700001").run();
  resolve({ success: true, message: "AI reply after human takeover" });
  const result = await pending;
  const row = db.prepare("SELECT status FROM agent_messages WHERE source_event_id='review-takeover:outbound'").get();
  assert.equal(result.reply_status, "simulated"); assert.ok(row);
  evidence.takeover_during_generation = { result, outbound: row, expected: "human_takeover; no channel send" };
  db.close();
}

// Two distinct events in one conversation finish in reverse order.
{
  const calls: DifyMessageInput[] = [];
  const resolvers: Array<(value: DifyMessageResult) => void> = [];
  const provider: DifyProvider = { sendMessage: p => { calls.push(p); return new Promise(r => resolvers.push(r)); }, healthCheck };
  const { db, service } = setup(provider);
  const first = service.handleInbound(input("review-first", "first question"));
  const second = service.handleInbound(input("review-second", "second question"));
  resolvers[1]({ success: true, message: "reply to second", conversation_id: "context-second" }); await second;
  resolvers[0]({ success: true, message: "reply to first", conversation_id: "context-first" }); await first;
  const row = db.prepare("SELECT last_msg,external_conversation_id FROM agent_conversations WHERE customer_id=700001").get();
  assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.conversationId));
  assert.equal(row?.last_msg, "reply to first");
  evidence.concurrent_conversation = { calls: calls.map(c => ({ query: c.query, conversationId: c.conversationId ?? null })), final_conversation: row };
  db.close();
}

process.env.REA_DATABASE_PATH = ":memory:";
process.env.REA_WEBHOOK_SECRET = "review-only";
process.env.REA_DIFY_PROVIDER = "mock";
process.env.REA_MESSAGE_CHANNEL_PROVIDER = "mock";
process.env.REA_LOCAL_SEED_PASSWORD = "review-only-password";
const app = buildServer();
await app.ready();
try {
  const login = async (username: string) => {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "review-only-password" } });
    assert.equal(response.statusCode, 200);
    return { authorization: `Bearer ${response.json().access_token}` };
  };
  const admin = await login("local-admin"), recruiter = await login("local-recruiter");
  const webhook = async (id: string) => {
    const payload = { id, event: "message.created", data: { device_code: "local-device-001", customer_id: 700001, content: "review message" } };
    return app.inject({ method: "POST", url: "/api/v1/webhooks/dify", payload, headers: { "x-dify-signature": createHmac("sha256", "review-only").update(JSON.stringify(payload)).digest("hex") } });
  };

  // Simulate the persisted state left by a process exit during a send.
  const events = new MessageEventService(app.db, { webhookSecret: "review-only" });
  events.recordEvent({ eventId: "review-stuck:reply", eventType: "message.reply.generated", direction: "outbound", payload: {} });
  const delivery = events.createDelivery({ eventId: "review-stuck:reply", deviceCode: "local-device-001", customerId: 700001, content: "" });
  events.markDeliverySending(delivery.delivery_id);
  const retry = await webhook("review-stuck");
  assert.equal(retry.statusCode, 500);
  evidence.interrupted_delivery_retry = { http: retry.statusCode, body: retry.json(), delivery: app.db.prepare("SELECT status,attempts FROM message_deliveries WHERE id=?").get(delivery.delivery_id) };

  const first = await webhook("review-duplicate"), duplicate = await webhook("review-duplicate");
  assert.equal(first.json().reply_status, "simulated"); assert.equal(duplicate.json().reply_status, "sent");
  evidence.duplicate_simulation_status = { first: first.json(), duplicate: duplicate.json() };

  // The list correctly hides city 99, but the workbook contains its marker.
  app.db.prepare("INSERT INTO cities(id,city_name) VALUES(99,'Review hidden city')").run();
  app.db.prepare("INSERT INTO factories(id,factory_name,city_id) VALUES(99,'AUDIT_HIDDEN_FACTORY',99)").run();
  const list = await app.inject({ method: "GET", url: "/api/v1/factories", headers: recruiter });
  const exported = await app.inject({ method: "GET", url: "/api/v1/import-export/factories/export", headers: recruiter });
  assert.equal(list.statusCode, 200); assert.equal(exported.statusCode, 200);
  assert.ok(!list.body.includes("AUDIT_HIDDEN_FACTORY")); assert.ok(exported.rawPayload.includes(Buffer.from("AUDIT_HIDDEN_FACTORY")));
  evidence.export_scope_bypass = { user: "local-recruiter", hidden_city: 99, list_has_marker: false, workbook_has_marker: true, http: exported.statusCode };

  app.db.prepare("INSERT INTO agent_conversations(device_code,customer_id,unread) VALUES('unassigned-device',700099,7)").run();
  const unread = await app.inject({ method: "POST", url: "/api/v1/agent/device/1/clear-unread", headers: recruiter });
  const unrelatedUnread = app.db.prepare("SELECT unread FROM agent_conversations WHERE device_code='unassigned-device'").get();
  assert.equal(unread.statusCode, 200); assert.equal(unrelatedUnread?.unread, 0);
  evidence.clear_unread = { user: "local-recruiter", http: unread.statusCode, body: unread.json(), unassigned_device_unread_before: 7, unassigned_device_unread_after: unrelatedUnread?.unread };

  const manual = await app.inject({ method: "POST", url: "/api/v1/agent/manual-reply", headers: admin, payload: { device_code: "local-device-001", customer_id: 700001, content: "review manual reply" } });
  assert.equal(manual.statusCode, 200); assert.equal(manual.json().status, "sent");
  const manualDelivery = app.db.prepare("SELECT count(*) AS count FROM message_deliveries WHERE content='review manual reply'").get();
  assert.equal(manualDelivery?.count, 0);
  evidence.manual_reply = { http: manual.statusCode, status: manual.json().status, delivery_count: manualDelivery?.count };

  const record = app.db.prepare("INSERT INTO activation_records(customer_id,device_code) VALUES(700001,'local-device-001') RETURNING id").get()!;
  const run = await app.inject({ method: "POST", url: `/api/v1/activation/records/${record.id}/run`, headers: admin, payload: {} });
  assert.equal(run.statusCode, 200); assert.equal(run.json().status, "sent");
  const jobCount = app.db.prepare("SELECT count(*) AS count FROM jobs").get();
  evidence.activation_run = { http: run.statusCode, status: run.json().status, tier: run.json().tier, jobs: jobCount?.count };

  const importResponse = await app.inject({ method: "POST", url: "/api/v1/import-export/factories/import", headers: { ...admin, "content-type": "multipart/form-data; boundary=review" }, payload: '--review\r\nContent-Disposition: form-data; name="file"; filename="review.csv"\r\nContent-Type: text/csv\r\n\r\nfactory_name,city_id\r\nREVIEW_IMPORT,1\r\n--review--\r\n' });
  assert.equal(importResponse.statusCode, 200); assert.equal(importResponse.json().total, 0);
  evidence.import_stub = { http: importResponse.statusCode, body: importResponse.json() };

  const before = JSON.parse(String(app.db.prepare("SELECT data_json FROM agent_devices WHERE id=1").get()?.data_json));
  const deleted = await app.inject({ method: "DELETE", url: "/api/v1/agent/device/1/workflow", headers: admin });
  const after = JSON.parse(String(app.db.prepare("SELECT data_json FROM agent_devices WHERE id=1").get()?.data_json));
  const lostRoute = await webhook("review-after-workflow-delete");
  assert.equal(deleted.statusCode, 200); assert.deepEqual(after, {}); assert.equal(lostRoute.statusCode, 502);
  evidence.delete_workflow = { before_keys: Object.keys(before), after, webhook_http: lostRoute.statusCode, webhook: lostRoute.json() };
} finally { await app.close(); }
writeFileSync("过程文件/latest-review-evidence-20261025.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
