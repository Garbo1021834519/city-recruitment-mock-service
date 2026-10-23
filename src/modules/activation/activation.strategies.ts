import type { ActivationStrategyCode } from "./activation.rules.js";

export interface ActivationStrategyDefinition {
  code: ActivationStrategyCode;
  enabled: boolean;
  description: string;
  trigger: string;
  config: Record<string, unknown>;
}

export const ACTIVATION_STRATEGY_DEFAULTS: readonly ActivationStrategyDefinition[] = [
  {
    code: "no_reply",
    enabled: true,
    description: "AI 最后回复后客户长期未再响应的沉淀客户",
    trigger: "最后一条为 AI 消息且沉默 1~3 天、首次对话在 10 天内",
    config: { stale_days: 1, stale_days_max: 3, conversation_max_days: 10, daily_limit: 200, send_window: ["09:00", "21:00"], cooldown_days: 14, auto_push: { enabled: true, offsets_days: [1, 2, 3] } },
  },
  {
    code: "date_trigger",
    enabled: false,
    description: "已邀约/已提醒但面试日临近或已过且未签到的客户",
    trigger: "面试日期在前 1 天至后 2 天窗口内，未发现签到事件",
    config: { days_before: 1, days_after: 2, daily_limit: 20, send_window: ["09:00", "21:00"], cooldown_days: 14 },
  },
  {
    code: "misjudge",
    enabled: false,
    description: "被判不符合后仍主动回复、疑似误判的客户",
    trigger: "不符合事件后 72 小时内客户再次发来消息",
    config: { window_hours: 72, daily_limit: 20, send_window: ["09:00", "21:00"], cooldown_days: 14 },
  },
  {
    code: "paused",
    enabled: false,
    description: "明确暂缓求职并已超过安静期的客户",
    trigger: "客户表达暂缓意图且最后发言至少 5 天",
    config: { silence_days: 5, daily_limit: 20, send_window: ["09:00", "21:00"], cooldown_days: 14 },
  },
];

export function activationStrategyDefault(code: string): ActivationStrategyDefinition | undefined {
  return ACTIVATION_STRATEGY_DEFAULTS.find((strategy) => strategy.code === code);
}

export function isActivationStrategyCode(code: string): code is ActivationStrategyCode {
  return activationStrategyDefault(code) !== undefined;
}
