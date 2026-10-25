import type { DatabaseSync } from "node:sqlite";
import type { DifyProvider } from "../dify/dify-provider.js";
import type { MessageEventService } from "./message-events.js";
import type { MessageChannelProvider } from "./message-channel-provider.js";

interface IncomingMessage {
  eventId: string;
  deviceCode: string;
  customerId: number;
  content: string;
}

interface ConversationRow {
  takeover: number;
  external_conversation_id: string | null;
}

interface DeviceRow {
  data_json: string;
}

interface DeliveryRow {
  id: number;
  status: string;
  content: string;
}

export interface InboundMessageResult {
  status: "processed" | "duplicate";
  event_id: string;
  reply_status: "simulated" | "sent" | "human_takeover" | "failed";
  error?: string;
}

export class MessageAutomationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly events: MessageEventService,
    private readonly dify: DifyProvider,
    private readonly channel: MessageChannelProvider,
  ) {}

  async handleInbound(input: IncomingMessage): Promise<InboundMessageResult> {
    const now = new Date().toISOString();
    const inserted = this.db.prepare(
      "INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id) VALUES (?,?, 'inbound',?,'received',?,?)",
    ).run(input.deviceCode, input.customerId, input.content, now, input.eventId);
    if (Number(inserted.changes) === 1) {
      this.db.prepare(`
        INSERT INTO agent_conversations(device_code,customer_id,last_msg,last_msg_at,unread,updated_at)
        VALUES (?,?,?,?,1,?)
        ON CONFLICT(device_code,customer_id) DO UPDATE SET
          last_msg=excluded.last_msg,last_msg_at=excluded.last_msg_at,
          unread=agent_conversations.unread+1,updated_at=excluded.updated_at
      `).run(input.deviceCode, input.customerId, input.content, now, now);
    }

    const conversation = this.db.prepare(
      "SELECT takeover,external_conversation_id FROM agent_conversations WHERE device_code=? AND customer_id=?",
    ).get(input.deviceCode, input.customerId) as ConversationRow | undefined;
    if (conversation?.takeover) {
      return { status: "processed", event_id: input.eventId, reply_status: "human_takeover" };
    }

    const device = this.db.prepare(
      "SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? AND status='enabled' LIMIT 1",
    ).get(input.deviceCode) as DeviceRow | undefined;
    if (!device) return this.failed(input.eventId, "Enabled message device not found");
    let deviceData: Record<string, unknown>;
    try { deviceData = JSON.parse(device.data_json || "{}") as Record<string, unknown>; }
    catch { return this.failed(input.eventId, "Message device configuration is invalid"); }

    const replyEventId = `${input.eventId}:reply`;
    this.events.recordEvent({
      eventId: replyEventId,
      eventType: "message.reply.generated",
      direction: "outbound",
      deviceCode: input.deviceCode,
      customerId: input.customerId,
      payload: { source_event_id: input.eventId },
    });

    let delivery = this.db.prepare(
      "SELECT id,status,content FROM message_deliveries WHERE event_id=? ORDER BY id LIMIT 1",
    ).get(replyEventId) as DeliveryRow | undefined;
    if (delivery?.status === "succeeded") {
      return { status: "duplicate", event_id: input.eventId, reply_status: "sent" };
    }
    if (!delivery) {
      const created = this.events.createDelivery({
        eventId: replyEventId,
        deviceCode: input.deviceCode,
        customerId: input.customerId,
        content: "",
      });
      delivery = this.db.prepare("SELECT id,status,content FROM message_deliveries WHERE id=?").get(created.delivery_id) as unknown as DeliveryRow;
    }

    this.events.markDeliverySending(delivery.id);
    let reply = delivery.content;
    if (!reply) {
      const result = await this.dify.sendMessage({
        baseUrl: String(deviceData.dify_url ?? "mock://local"),
        apiKey: String(deviceData.dify_key ?? ""),
        user: String(input.customerId),
        query: input.content,
        ...(conversation?.external_conversation_id ? { conversationId: conversation.external_conversation_id } : {}),
        inputs: { device_code: input.deviceCode, customer_id: input.customerId },
      });
      if (!result.success || !result.message?.trim()) {
        return this.failed(input.eventId, result.error ?? "Dify returned an empty reply", delivery.id);
      }
      reply = result.message;
      this.db.prepare("UPDATE message_deliveries SET content=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reply, delivery.id);
      if (result.conversation_id) {
        this.db.prepare("UPDATE agent_conversations SET external_conversation_id=? WHERE device_code=? AND customer_id=?")
          .run(result.conversation_id, input.deviceCode, input.customerId);
      }
    }

    const sent = await this.channel.sendMessage({
      deviceCode: input.deviceCode,
      customerId: input.customerId,
      content: reply,
      idempotencyKey: `${input.eventId}:reply`,
    });
    if (!sent.success) return this.failed(input.eventId, sent.error ?? "Message channel send failed", delivery.id);

    const outboundEventId = `${input.eventId}:outbound`;
    this.db.prepare(
      "INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id) VALUES (?,?, 'outbound',?,?,?,?)",
    ).run(input.deviceCode, input.customerId, reply, sent.simulated ? "simulated" : "sent", new Date().toISOString(), outboundEventId);
    this.db.prepare("UPDATE agent_conversations SET last_msg=?,last_msg_at=?,updated_at=? WHERE device_code=? AND customer_id=?")
      .run(reply, new Date().toISOString(), new Date().toISOString(), input.deviceCode, input.customerId);
    this.events.markDeliverySucceeded(delivery.id, sent.message_id);

    return { status: "processed", event_id: input.eventId, reply_status: sent.simulated ? "simulated" : "sent" };
  }

  private failed(eventId: string, error: string, deliveryId?: number): InboundMessageResult {
    if (deliveryId !== undefined) this.events.markDeliveryFailed(deliveryId, error);
    return { status: "processed", event_id: eventId, reply_status: "failed", error: error.slice(0, 300) };
  }
}
