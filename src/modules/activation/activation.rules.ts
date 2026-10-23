export type ActivationStrategyCode = "no_reply" | "date_trigger" | "misjudge" | "paused";
export type ActivationRow = Record<string, string | number | boolean | null | undefined>;

export interface ActivationRuleContext {
  conversation: ActivationRow | null;
  messages: ActivationRow[];
  candidateEvents: ActivationRow[];
  lastActivationAt: string | null;
}

export interface ActivationRuleResult {
  matched: boolean;
  reason: string;
  strategy: ActivationStrategyCode;
  next_push_at: string | null;
  eligible: boolean;
}

export function summarizeActivationRule(strategy: ActivationStrategyCode, context: ActivationRuleContext, result: ActivationRuleResult, now = new Date()): string {
  if (!result.matched) {
    if (result.reason === "no_interview_invitation") return "未找到该客户的面试邀约记录。";
    if (result.reason === "candidate_checked_in") return "已发现客户签到记录，不需要发送到期提醒。";
    if (result.reason === "no_recent_inbound_after_disqualification") return "不符合事件后没有 72 小时内的客户新消息。";
    if (result.reason === "pause_conditions_not_met") return "没有同时满足暂缓求职意向和静默期的客户消息。";
    if (result.reason === "no_reply_conditions_not_met") return "最近消息方向、沉默时长或首次对话时间不满足无回复策略。";
    return "该客户尚未满足当前策略的触发条件。";
  }

  const messages = ordered(context.messages);
  const events = ordered(context.candidateEvents);
  if (strategy === "no_reply") {
    const latestAt = dateValue(messages[0]?.created_at);
    const conversationAt = dateValue(context.conversation?.created_at);
    const silenceDays = latestAt ? Math.max(1, Math.floor((now.getTime() - latestAt.getTime()) / DAY_MS)) : 0;
    const conversationDays = conversationAt ? Math.max(0, Math.floor((now.getTime() - conversationAt.getTime()) / DAY_MS)) : 0;
    return `客户最后一条消息由坐席发送，已沉默约 ${silenceDays} 天；首次对话距今 ${conversationDays} 天，符合无回复策略窗口。`;
  }
  if (strategy === "date_trigger") {
    const invitation = events.find((event) => event.event_type === "invited");
    return `面试日期 ${String(invitation?.interview_date ?? "")} 位于激活窗口，且没有后续签到记录。`;
  }
  if (strategy === "misjudge") {
    const disqualified = events.find((event) => event.event_type === "disqualified");
    const inbound = messages.find((message) => message.direction === "inbound");
    const start = dateValue(disqualified?.event_at);
    const end = dateValue(inbound?.created_at);
    const hours = start && end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 3_600_000)) : 0;
    return `客户在不符合事件后约 ${hours} 小时内再次发来消息，可能存在误判。`;
  }
  const inbound = messages.find((message) => message.direction === "inbound");
  const inboundAt = dateValue(inbound?.created_at);
  const silenceDays = inboundAt ? Math.max(0, Math.floor((now.getTime() - inboundAt.getTime()) / DAY_MS)) : 0;
  return `客户消息表达了暂缓求职意向，且已静默约 ${silenceDays} 天。`;
}

interface EvaluateInput {
  strategy: ActivationStrategyCode;
  context: ActivationRuleContext;
  now?: Date;
  config?: Record<string, unknown>;
  globallyPaused?: boolean;
}

const PAUSE_PHRASES = ["先不考虑", "暂时不找", "过几天", "过段时间", "过完这周", "回老家", "等我回来", "以后再联系"];
const DAY_MS = 86_400_000;

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function numberOption(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
}

function ordered(rows: ActivationRow[]): ActivationRow[] {
  return [...rows].sort((a, b) => (dateValue(b.created_at ?? b.event_at)?.getTime() ?? 0) - (dateValue(a.created_at ?? a.event_at)?.getTime() ?? 0));
}

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function ruleMatch(strategy: ActivationStrategyCode, context: ActivationRuleContext, now: Date, config: Record<string, unknown>): { matched: boolean; reason: string } {
  const messages = ordered(context.messages);
  const events = ordered(context.candidateEvents);

  if (strategy === "no_reply") {
    const conversationAt = dateValue(context.conversation?.created_at);
    const latest = messages[0];
    const latestAt = dateValue(latest?.created_at);
    const silenceDays = latestAt ? (now.getTime() - latestAt.getTime()) / DAY_MS : -1;
    const ageDays = conversationAt ? (now.getTime() - conversationAt.getTime()) / DAY_MS : Infinity;
    const minDays = numberOption(config, "stale_days", 1);
    const maxDays = numberOption(config, "stale_days_max", 3);
    const maxAgeDays = numberOption(config, "conversation_max_days", 10);
    const matched = Boolean(latest && latest.direction === "outbound" && silenceDays >= minDays && silenceDays <= maxDays && ageDays >= 0 && ageDays <= maxAgeDays);
    return { matched, reason: matched ? "customer_silent_after_outbound" : "no_reply_conditions_not_met" };
  }

  if (strategy === "date_trigger") {
    const invitation = events.find((event) => event.event_type === "invited" && typeof event.interview_date === "string" && event.interview_date !== "");
    if (!invitation) return { matched: false, reason: "no_interview_invitation" };
    const checkedIn = events.some((event) => event.event_type === "checked_in" && (dateValue(event.event_at)?.getTime() ?? 0) >= (dateValue(invitation.event_at)?.getTime() ?? 0));
    const interviewDate = dateValue(`${String(invitation.interview_date)}T00:00:00.000Z`);
    if (!interviewDate || checkedIn) return { matched: false, reason: checkedIn ? "candidate_checked_in" : "invalid_interview_date" };
    const deltaDays = (utcDay(interviewDate) - utcDay(now)) / DAY_MS;
    const daysBefore = numberOption(config, "days_before", 1);
    const daysAfter = numberOption(config, "days_after", 2);
    const matched = deltaDays >= -daysBefore && deltaDays <= daysAfter;
    return { matched, reason: matched ? "interview_in_activation_window" : "interview_outside_activation_window" };
  }

  if (strategy === "misjudge") {
    const disqualified = events.find((event) => event.event_type === "disqualified");
    const inbound = messages.find((message) => message.direction === "inbound");
    const disqualifiedAt = dateValue(disqualified?.event_at);
    const inboundAt = dateValue(inbound?.created_at);
    const hours = disqualifiedAt && inboundAt ? (inboundAt.getTime() - disqualifiedAt.getTime()) / 3_600_000 : -1;
    const windowHours = numberOption(config, "window_hours", 72);
    const matched = Boolean(disqualifiedAt && inboundAt && hours >= 0 && hours <= windowHours);
    return { matched, reason: matched ? "inbound_after_disqualification" : "no_recent_inbound_after_disqualification" };
  }

  const latestInbound = messages.find((message) => message.direction === "inbound");
  const inboundAt = dateValue(latestInbound?.created_at);
  const content = typeof latestInbound?.content === "string" ? latestInbound.content : "";
  const silenceDays = inboundAt ? (now.getTime() - inboundAt.getTime()) / DAY_MS : -1;
  const requiredDays = numberOption(config, "silence_days", 5);
  const containsPauseIntent = PAUSE_PHRASES.some((phrase) => content.includes(phrase));
  const matched = Boolean(latestInbound && containsPauseIntent && silenceDays >= requiredDays);
  return { matched, reason: matched ? "pause_phrase_and_quiet_period" : "pause_conditions_not_met" };
}

export function evaluateActivationRule(input: EvaluateInput): ActivationRuleResult {
  const { strategy, context } = input;
  const now = input.now ?? new Date();
  const config = input.config ?? {};
  const match = ruleMatch(strategy, context, now, config);
  if (!match.matched) return { matched: false, reason: match.reason, strategy, next_push_at: null, eligible: false };

  if (input.globallyPaused) return { matched: true, reason: "activation_paused", strategy, next_push_at: null, eligible: false };
  if (config.enabled !== true) return { matched: true, reason: "strategy_disabled", strategy, next_push_at: null, eligible: false };

  const cooldownDays = Math.max(0, numberOption(config, "cooldown_days", 14));
  const lastActivation = dateValue(context.lastActivationAt);
  if (lastActivation) {
    const nextPush = new Date(lastActivation.getTime() + cooldownDays * DAY_MS);
    if (nextPush > now) return { matched: true, reason: "cooldown_active", strategy, next_push_at: nextPush.toISOString(), eligible: false };
  }
  return { matched: true, reason: match.reason, strategy, next_push_at: now.toISOString(), eligible: true };
}
