import type { DatabaseSync } from "node:sqlite";
import { JobExecutor } from "../scheduler/scheduler.js";
import { JobStore, type Clock, type JobRecord } from "../scheduler/job-store.js";
import { evaluateActivationRule, type ActivationRuleContext, type ActivationStrategyCode } from "./activation.rules.js";
import { ACTIVATION_STRATEGY_DEFAULTS, activationStrategyDefault } from "./activation.strategies.js";
import { MockDifyProvider, type DifyProvider } from "../dify/dify-provider.js";
import { MessageEventService } from "../messaging/message-events.js";

const STRATEGIES = ACTIVATION_STRATEGY_DEFAULTS.map((strategy) => strategy.code);

function iso(clock: Clock): string { return clock.now().toISOString(); }

function parseConfig(db: DatabaseSync, code: ActivationStrategyCode): Record<string, unknown> & { enabled: boolean } {
  const definition = activationStrategyDefault(code);
  if (!definition) throw new Error(`Unknown activation strategy: ${code}`);
  const row = db.prepare("SELECT enabled,config_json FROM activation_strategy_rules WHERE code=?").get(code) as { enabled: number; config_json: string } | undefined;
  return { ...definition.config, ...(row ? JSON.parse(row.config_json) as Record<string, unknown> : {}), enabled: row ? Boolean(row.enabled) : definition.enabled };
}

function contextFor(db: DatabaseSync, customerId: string, strategy: ActivationStrategyCode): ActivationRuleContext {
  const conversation = db.prepare("SELECT customer_id,device_code,state,recruit_status,created_at,last_msg_at FROM agent_conversations WHERE CAST(customer_id AS TEXT)=? ORDER BY updated_at DESC LIMIT 1").get(customerId) as Record<string, string | number | null> | undefined;
  const messages = db.prepare(`SELECT device_code,customer_id,direction,content,created_at FROM agent_messages WHERE CAST(customer_id AS TEXT)=? ${conversation ? "AND device_code=?" : ""} ORDER BY created_at DESC,id DESC`).all(...(conversation ? [customerId, String(conversation.device_code)] : [customerId])) as Array<Record<string, string | number | null>>;
  const candidateEvents = db.prepare("SELECT customer_id,event_type,event_at,interview_date,status,disqualified_reason FROM candidate_events WHERE customer_id=? ORDER BY event_at DESC,id DESC").all(customerId) as Array<Record<string, string | number | null>>;
  const activation = db.prepare("SELECT created_at FROM activation_records WHERE CAST(customer_id AS TEXT)=? AND strategy=? ORDER BY id DESC LIMIT 1").get(customerId, strategy) as { created_at: string } | undefined;
  return { conversation: conversation ?? null, messages, candidateEvents, lastActivationAt: activation?.created_at ?? null };
}

export class ActivationJobService {
  private readonly provider: DifyProvider;
  private readonly events: MessageEventService;

  constructor(private readonly db: DatabaseSync, private readonly store: JobStore, private readonly clock: Clock, provider?: DifyProvider, events?: MessageEventService) {
    this.provider = provider ?? new MockDifyProvider();
    this.events = events ?? new MessageEventService(db, { webhookSecret: process.env.REA_WEBHOOK_SECRET ?? "local-webhook-secret" });
  }

  enqueueScan(strategy?: ActivationStrategyCode): JobRecord {
    return this.store.enqueue({ kind: "activation.scan", payload: { strategy: strategy ?? null } });
  }

  enqueueConfiguredScan(): JobRecord {
    return this.enqueueScan();
  }

  enqueueMessageSend(recordId: number): JobRecord {
    const record = this.db.prepare("SELECT customer_id,device_code FROM activation_records WHERE id=?").get(recordId) as { customer_id: number; device_code: string } | undefined;
    if (!record) throw new Error(`Activation record not found: ${recordId}`);
    return this.store.enqueue({ kind: "message.send", payload: { activation_record_id: recordId, customer_id: record.customer_id, device_code: record.device_code } });
  }

  registerExecutors(executor: JobExecutor): void {
    executor.register("activation.scan", (job) => this.runScan(job));
    executor.register("message.send", (job) => this.runMessageSend(job));
  }

  private runScan(job: JobRecord): void {
    const requested = typeof job.payload.strategy === "string" ? job.payload.strategy : null;
    const codes = requested ? [requested as ActivationStrategyCode] : STRATEGIES;
    const globallyPaused = Boolean((this.db.prepare("SELECT paused FROM activation_config WHERE id=1").get() as { paused: number } | undefined)?.paused);
    for (const strategy of codes) {
      if (!STRATEGIES.includes(strategy)) throw new Error(`Unknown activation strategy: ${strategy}`);
      const config = parseConfig(this.db, strategy);
      if (!config.enabled || globallyPaused) continue;
      const customerIds = this.customerIds();
      for (const customerId of customerIds) {
        const context = contextFor(this.db, customerId, strategy);
        const result = evaluateActivationRule({ strategy, context, config, globallyPaused, now: this.clock.now() });
        if (!result.matched || !result.eligible) continue;
        const nickname = String(context.conversation?.nickname ?? "");
        const deviceCode = String(context.conversation?.device_code ?? "");
        const insert = this.db.prepare(
          "INSERT INTO activation_records(customer_id,nickname,strategy,device_code,status,summary,next_push_at,reason) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM activation_records WHERE customer_id=? AND strategy=? AND status NOT IN ('skipped','expired'))",
        ).run(Number(customerId), nickname, strategy, deviceCode, config.auto_review === true ? "pending_send" : "pending_review", "", result.next_push_at, result.reason, Number(customerId), strategy);
        if (Number(insert.changes) === 1) {
          const record = this.db.prepare("SELECT id FROM activation_records WHERE rowid=last_insert_rowid()").get() as { id: number };
          if (config.auto_review === true) this.enqueueMessageSend(record.id);
        }
      }
    }
  }

  private async runMessageSend(job: JobRecord): Promise<void> {
    const recordId = Number(job.payload.activation_record_id);
    const record = this.db.prepare("SELECT id,customer_id,device_code,status,script,tier FROM activation_records WHERE id=?").get(recordId) as { id: number; customer_id: number; device_code: string; status: string; script: string; tier: number } | undefined;
    if (!record) throw new Error(`Activation record not found: ${recordId}`);
    if (record.status === "sent" || record.status === "replied") return;
    if (!['pending_send', 'pending_review'].includes(record.status)) return;
    const message = record.script || String((this.db.prepare("SELECT content FROM activation_scripts WHERE status='enabled' ORDER BY id LIMIT 1").get() as { content: string } | undefined)?.content ?? "");
    if (!message) throw new Error("No enabled activation script available");
    const eventId = `activation-send:${record.id}:${record.tier + 1}`;
    this.events.recordEvent({ eventId, eventType: "message.sent", direction: "outbound", deviceCode: record.device_code, customerId: record.customer_id, payload: { activation_record_id: record.id, query_length: message.length } });
    const delivery = this.events.createDelivery({ eventId, deviceCode: record.device_code, customerId: record.customer_id, content: message });
    this.events.markDeliverySending(delivery.delivery_id);
    const device = this.db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? LIMIT 1").get(record.device_code) as { data_json: string } | undefined;
    const deviceData = device && typeof device.data_json === "string" ? JSON.parse(device.data_json) as Record<string, unknown> : {};
    const providerResult = await this.provider.sendMessage({
      baseUrl: String(deviceData.dify_url ?? "mock://local"),
      apiKey: String(deviceData.dify_key ?? ""),
      user: String(record.customer_id),
      query: message,
    });
    if (!providerResult.success) {
      this.events.markDeliveryFailed(delivery.delivery_id, providerResult.error ?? "Dify provider failed");
      throw new Error(providerResult.error ?? "Dify provider failed");
    }
    const outgoing = providerResult.message || message;
    const exists = this.db.prepare("SELECT id FROM agent_messages WHERE device_code=? AND customer_id=? AND direction='outbound' AND content=? AND created_at>=datetime('now','-1 day') LIMIT 1").get(record.device_code, record.customer_id, outgoing);
    if (!exists) this.db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,status,created_at) VALUES (?,?, 'outbound',?,'sent',?)").run(record.device_code, record.customer_id, outgoing, iso(this.clock));
    this.events.markDeliverySucceeded(delivery.delivery_id, providerResult.message_id);
    this.db.prepare("UPDATE activation_records SET status='sent',script=?,tier=tier+1,updated_at=? WHERE id=? AND status IN ('pending_send','pending_review')").run(outgoing, iso(this.clock), recordId);
  }

  private customerIds(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT CAST(customer_id AS TEXT) AS customer_id FROM agent_conversations UNION SELECT DISTINCT CAST(customer_id AS TEXT) AS customer_id FROM candidate_events").all() as Array<{ customer_id: string }>;
    return rows.map((row) => row.customer_id);
  }
}
