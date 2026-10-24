import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.js";
import { MessageEventService } from "../src/modules/messaging/message-events.js";

describe("message events, deliveries and webhook logs", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => { db?.close(); db = undefined; });

  function setup() {
    db = new DatabaseSync(":memory:");
    migrateDatabase(db);
    return { db, service: new MessageEventService(db, { webhookSecret: "webhook-test-secret" }) };
  }

  it("records the same message event once and preserves only a payload summary/hash", () => {
    const { db: database, service } = setup();
    const first = service.recordEvent({ eventId: "evt-1", eventType: "message.received", direction: "inbound", deviceCode: "device-1", customerId: 501, payload: { content: "private text", phone: "13800000000" } });
    const duplicate = service.recordEvent({ eventId: "evt-1", eventType: "message.received", direction: "inbound", deviceCode: "device-1", customerId: 501, payload: { content: "different retry body" } });

    expect(first).toMatchObject({ created: true, event_id: "evt-1" });
    expect(duplicate).toEqual({ created: false, duplicate: true, event_id: "evt-1" });
    expect((database.prepare("SELECT COUNT(*) count FROM message_events WHERE event_id='evt-1'").get() as { count: number }).count).toBe(1);
    const stored = database.prepare("SELECT payload_hash,payload_summary FROM message_events WHERE event_id='evt-1'").get() as { payload_hash: string; payload_summary: string };
    expect(stored.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.payload_summary).not.toContain("private text");
    expect(stored.payload_summary).not.toContain("13800000000");
  });

  it("tracks delivery attempts and provider ids through success/failure transitions", () => {
    const { db: database, service } = setup();
    service.recordEvent({ eventId: "evt-2", eventType: "message.sent", direction: "outbound", deviceCode: "device-1", customerId: 502, payload: { content: "reply" } });
    const delivery = service.createDelivery({ eventId: "evt-2", customerId: 502, deviceCode: "device-1", content: "reply" });
    expect(delivery).toMatchObject({ created: true, status: "queued" });
    expect(service.markDeliverySending(delivery.delivery_id)).toMatchObject({ status: "sending", attempts: 1 });
    expect(service.markDeliveryFailed(delivery.delivery_id, "provider timeout", "2026-10-24T00:00:01.000Z")).toMatchObject({ status: "failed", attempts: 1, last_error: "provider timeout" });
    expect(service.markDeliverySending(delivery.delivery_id)).toMatchObject({ status: "sending", attempts: 2 });
    expect(service.markDeliverySucceeded(delivery.delivery_id, "provider-msg-1")).toMatchObject({ status: "succeeded", provider_message_id: "provider-msg-1" });
    expect(database.prepare("SELECT status,attempts,last_error,provider_message_id FROM message_deliveries WHERE id=?").get(delivery.delivery_id)).toMatchObject({ status: "succeeded", attempts: 2, last_error: null, provider_message_id: "provider-msg-1" });
  });

  it("accepts a signed webhook, makes duplicate delivery idempotent, and logs invalid signatures", () => {
    const { db: database, service } = setup();
    const body = { id: "webhook-1", event: "message.created", data: { device_code: "device-1", customer_id: 503, content: "reply" } };
    const raw = JSON.stringify(body);
    const signature = createHmac("sha256", "webhook-test-secret").update(raw).digest("hex");
    const accepted = service.handleWebhook(raw, signature);
    const duplicate = service.handleWebhook(raw, signature);
    const rejected = service.handleWebhook(JSON.stringify({ id: "webhook-2", content: "bad" }), "invalid-signature");

    expect(accepted).toMatchObject({ status: "processed", event_id: "webhook-1" });
    expect(duplicate).toMatchObject({ status: "duplicate", event_id: "webhook-1" });
    expect(rejected).toMatchObject({ status: "rejected", reason: "invalid_signature" });
    expect((database.prepare("SELECT COUNT(*) count FROM webhook_logs WHERE status='processed'").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) count FROM webhook_logs WHERE status='duplicate'").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) count FROM webhook_logs WHERE status='rejected'").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) count FROM message_events WHERE event_id='webhook-1'").get() as { count: number }).count).toBe(1);
  });
});
