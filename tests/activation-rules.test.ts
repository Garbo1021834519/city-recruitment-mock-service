import { describe, expect, it } from "vitest";
import { evaluateActivationRule, type ActivationRuleContext } from "../src/modules/activation/activation.rules.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const base: ActivationRuleContext = {
  conversation: { created_at: "2026-10-20T12:00:00.000Z", recruit_status: "active" },
  messages: [],
  candidateEvents: [],
  lastActivationAt: null,
};

describe("activation rule engine", () => {
  it("matches a recent conversation whose latest message is outbound and has been silent within the configured window", () => {
    const result = evaluateActivationRule({
      strategy: "no_reply",
      context: { ...base, messages: [{ direction: "outbound", content: "岗位信息", created_at: "2026-10-21T12:00:00.000Z" }] },
      now: NOW,
      config: { enabled: true, stale_days: 1, stale_days_max: 3, conversation_max_days: 10, cooldown_days: 14 },
    });

    expect(result).toMatchObject({ strategy: "no_reply", matched: true, eligible: true, reason: "customer_silent_after_outbound" });
    expect(result.next_push_at).toBe(NOW.toISOString());
  });

  it("does not match no-reply when the customer replied, the silence window expired, or the conversation is too old", () => {
    const config = { enabled: true, stale_days: 1, stale_days_max: 3, conversation_max_days: 10 };
    const customerReplied = evaluateActivationRule({
      strategy: "no_reply",
      context: { ...base, messages: [{ direction: "inbound", content: "还在考虑", created_at: "2026-10-21T12:00:00.000Z" }] },
      now: NOW,
      config,
    });
    const tooRecent = evaluateActivationRule({
      strategy: "no_reply",
      context: { ...base, messages: [{ direction: "outbound", content: "岗位信息", created_at: "2026-10-23T10:00:00.000Z" }] },
      now: NOW,
      config,
    });
    const oldConversation = evaluateActivationRule({
      strategy: "no_reply",
      context: {
        ...base,
        conversation: { created_at: "2026-10-01T12:00:00.000Z", recruit_status: "active" },
        messages: [{ direction: "outbound", content: "岗位信息", created_at: "2026-10-21T12:00:00.000Z" }],
      },
      now: NOW,
      config,
    });

    expect(customerReplied.matched).toBe(false);
    expect(tooRecent.matched).toBe(false);
    expect(oldConversation.matched).toBe(false);
  });

  it("matches invited candidates inside the interview-date window unless a later check-in exists", () => {
    const context: ActivationRuleContext = {
      ...base,
      candidateEvents: [
        { event_type: "invited", status: "invited", interview_date: "2026-10-24", event_at: "2026-10-20T12:00:00.000Z" },
      ],
    };
    const matched = evaluateActivationRule({ strategy: "date_trigger", context, now: NOW, config: { enabled: true, days_before: 1, days_after: 2 } });
    const checkedIn = evaluateActivationRule({
      strategy: "date_trigger",
      context: { ...context, candidateEvents: [...context.candidateEvents, { event_type: "checked_in", status: "checked_in", interview_date: "", event_at: "2026-10-22T12:00:00.000Z" }] },
      now: NOW,
      config: { enabled: true, days_before: 1, days_after: 2 },
    });

    expect(matched).toMatchObject({ matched: true, eligible: true, reason: "interview_in_activation_window" });
    expect(checkedIn.matched).toBe(false);
  });

  it("matches a disqualified customer only when a later inbound message arrived within 72 hours", () => {
    const context: ActivationRuleContext = {
      ...base,
      candidateEvents: [{ event_type: "disqualified", status: "disqualified", event_at: "2026-10-22T12:00:00.000Z" }],
      messages: [{ direction: "inbound", content: "我还想看看", created_at: "2026-10-23T08:00:00.000Z" }],
    };
    const matched = evaluateActivationRule({ strategy: "misjudge", context, now: NOW, config: { enabled: true, window_hours: 72 } });
    const outsideWindow = evaluateActivationRule({
      strategy: "misjudge",
      context: { ...context, messages: [{ direction: "inbound", content: "我还想看看", created_at: "2026-10-20T08:00:00.000Z" }] },
      now: NOW,
      config: { enabled: true, window_hours: 72 },
    });

    expect(matched).toMatchObject({ matched: true, eligible: true, reason: "inbound_after_disqualification" });
    expect(outsideWindow.matched).toBe(false);
  });

  it("matches a pause phrase only after the configured quiet period", () => {
    const context: ActivationRuleContext = {
      ...base,
      messages: [{ direction: "inbound", content: "我过几天回广州再联系", created_at: "2026-10-17T12:00:00.000Z" }],
    };
    const matched = evaluateActivationRule({ strategy: "paused", context, now: NOW, config: { enabled: true, silence_days: 5 } });
    const tooSoon = evaluateActivationRule({
      strategy: "paused",
      context: { ...context, messages: [{ ...context.messages[0], created_at: "2026-10-20T12:00:00.000Z" }] },
      now: NOW,
      config: { enabled: true, silence_days: 5 },
    });

    expect(matched).toMatchObject({ matched: true, eligible: true, reason: "pause_phrase_and_quiet_period" });
    expect(tooSoon.matched).toBe(false);
  });

  it("keeps a match but blocks eligibility when disabled, globally paused, or inside cooldown", () => {
    const context: ActivationRuleContext = {
      ...base,
      messages: [{ direction: "outbound", content: "岗位信息", created_at: "2026-10-21T12:00:00.000Z" }],
      lastActivationAt: "2026-10-20T12:00:00.000Z",
    };
    const disabled = evaluateActivationRule({ strategy: "no_reply", context, now: NOW, config: { enabled: false, stale_days: 1, stale_days_max: 3, cooldown_days: 14 } });
    const paused = evaluateActivationRule({ strategy: "no_reply", context, now: NOW, config: { enabled: true, stale_days: 1, stale_days_max: 3, cooldown_days: 14 }, globallyPaused: true });
    const cooldown = evaluateActivationRule({ strategy: "no_reply", context, now: NOW, config: { enabled: true, stale_days: 1, stale_days_max: 3, cooldown_days: 14 } });

    expect(disabled).toMatchObject({ matched: true, eligible: false, reason: "strategy_disabled", next_push_at: null });
    expect(paused).toMatchObject({ matched: true, eligible: false, reason: "activation_paused", next_push_at: null });
    expect(cooldown).toMatchObject({ matched: true, eligible: false, reason: "cooldown_active", next_push_at: "2026-11-03T12:00:00.000Z" });
  });
});
