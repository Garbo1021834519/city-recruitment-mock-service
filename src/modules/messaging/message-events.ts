import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface EventInput {
  eventId: string;
  eventType: string;
  direction: string;
  deviceCode?: string;
  customerId?: number;
  payload: Record<string, unknown>;
}

interface DeliveryInput {
  eventId: string;
  deviceCode: string;
  customerId: number;
  content: string;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function summary(payload: Record<string, unknown>): string {
  const safe = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === "string" ? `[${value.length} chars]` : Array.isArray(value) ? `[array:${value.length}]` : typeof value]));
  return JSON.stringify(safe);
}

export class MessageEventService {
  constructor(private readonly db: DatabaseSync, private readonly options: { webhookSecret: string }) {}

  recordEvent(input: EventInput): { created: boolean; duplicate?: boolean; event_id: string } {
    const serialized = JSON.stringify(input.payload);
    const result = this.db.prepare("INSERT OR IGNORE INTO message_events(event_id,event_type,direction,device_code,customer_id,payload_hash,payload_summary) VALUES (?,?,?,?,?,?,?)")
      .run(input.eventId, input.eventType, input.direction, input.deviceCode ?? "", input.customerId ?? null, hash(serialized), summary(input.payload));
    return Number(result.changes) === 1 ? { created: true, event_id: input.eventId } : { created: false, duplicate: true, event_id: input.eventId };
  }

  createDelivery(input: DeliveryInput): { created: boolean; duplicate?: boolean; delivery_id: number; status: string } {
    const existing = this.db.prepare("SELECT id,status FROM message_deliveries WHERE event_id=? AND customer_id=? AND content=? ORDER BY id LIMIT 1").get(input.eventId, input.customerId, input.content) as { id: number; status: string } | undefined;
    if (existing) return { created: false, duplicate: true, delivery_id: existing.id, status: existing.status };
    const result = this.db.prepare("INSERT INTO message_deliveries(event_id,device_code,customer_id,content) VALUES (?,?,?,?)").run(input.eventId, input.deviceCode, input.customerId, input.content);
    return { created: true, delivery_id: Number(result.lastInsertRowid), status: "queued" };
  }

  markDeliverySending(id: number): { status: string; attempts: number } {
    const result = this.db.prepare("UPDATE message_deliveries SET status='sending',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','failed')").run(id);
    if (!result.changes) throw new Error("Delivery is not available for sending");
    return this.db.prepare("SELECT status,attempts FROM message_deliveries WHERE id=?").get(id) as { status: string; attempts: number };
  }

  markDeliveryFailed(id: number, error: string, nextRetryAt: string | null = null): Record<string, unknown> {
    this.db.prepare("UPDATE message_deliveries SET status='failed',last_error=?,next_retry_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(error.slice(0, 300), nextRetryAt, id);
    return this.db.prepare("SELECT status,attempts,last_error,next_retry_at FROM message_deliveries WHERE id=?").get(id) as Record<string, unknown>;
  }

  markDeliverySucceeded(id: number, providerMessageId?: string): Record<string, unknown> {
    this.db.prepare("UPDATE message_deliveries SET status='succeeded',last_error=NULL,next_retry_at=NULL,provider_message_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(providerMessageId ?? null, id);
    return this.db.prepare("SELECT status,attempts,last_error,provider_message_id FROM message_deliveries WHERE id=?").get(id) as Record<string, unknown>;
  }

  handleWebhook(rawBody: string, signature: string): { status: string; event_id?: string; reason?: string } {
    const payloadHash = hash(rawBody);
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return this.logWebhook(null, "rejected", payloadHash, {}, "invalid_json"); }
    const expected = createHmac("sha256", this.options.webhookSecret).update(rawBody).digest("hex");
    const valid = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    const webhookId = typeof body.id === "string" ? body.id : null;
    if (!valid) return this.logWebhook(webhookId, "rejected", payloadHash, body, "invalid_signature");
    const event = this.recordEvent({ eventId: webhookId ?? `webhook:${payloadHash}`, eventType: String(body.event ?? "webhook.received"), direction: "inbound", deviceCode: String((body.data as Record<string, unknown> | undefined)?.device_code ?? ""), customerId: Number((body.data as Record<string, unknown> | undefined)?.customer_id ?? 0) || undefined, payload: body });
    return this.logWebhook(webhookId ?? event.event_id, event.duplicate ? "duplicate" : "processed", payloadHash, body, event.duplicate ? "duplicate_event" : undefined);
  }

  private logWebhook(webhookId: string | null, status: "processed" | "duplicate" | "rejected", payloadHash: string, body: Record<string, unknown>, reason?: string) {
    this.db.prepare("INSERT INTO webhook_logs(webhook_id,status,payload_hash,payload_summary,reason) VALUES (?,?,?,?,?)").run(webhookId, status, payloadHash, summary(body), reason ?? null);
    return { status, ...(webhookId ? { event_id: webhookId } : {}), ...(reason ? { reason } : {}) };
  }
}
