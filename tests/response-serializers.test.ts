import { describe, expect, it } from "vitest";
import {
  serializeAgentDevice,
  serializeAccountSummary,
  serializeCandidate,
  serializeCity,
  serializeCityLinks,
  serializeEvaluationOverview,
  serializeFactory,
  serializeMetrics,
  serializeRecruiter,
  serializeServicePosition,
  serializeStatusDashboard,
} from "../src/shared/response-serializers.js";

describe("public response serializers", () => {
  it("serializes a city without leaking its storage JSON", () => {
    const city = serializeCity({
      id: 7,
      city_name: "示例市",
      province: "示例省",
      recruitment_status: "enabled",
      created_at: "2026-10-23T00:00:00Z",
      updated_at: "2026-10-23T00:00:00Z",
      data_json: JSON.stringify({ districts: ["甲区"], interview_site_name: "示例面试点", secret: "internal" }),
    });

    expect(city).toEqual({
      id: 7,
      city_name: "示例市",
      province: "示例省",
      recruitment_status: "enabled",
      districts: ["甲区"],
      interview_site_name: "示例面试点",
      social_insurances: "",
      flow_type: "standard",
      ask_accommodation: true,
      is_primary: false,
      gender_accommodation_policy: "none",
      factory_mode: "none",
      salary: { probation: {}, formal: {}, benefits: {}, document_url: "", raw: "" },
      interview: { days: [], time: "", location: "", coordinates: "", check_in_code: "", contact: "", room: "", guide_image: "", raw_time: "", raw_address: "", interview_notice: "", interview_guide: "" },
      available_lines: [],
      work_hours: { raw: "" },
      requirements: { raw: "" },
      prompt_sections: {},
      prompt_section_labels: {},
      sort_order: 0,
      created_at: "2026-10-23T00:00:00Z",
      updated_at: "2026-10-23T00:00:00Z",
    });
  });

  it("serializes a factory without leaking its storage JSON", () => {
    const factory = serializeFactory({
      id: 12,
      factory_name: "示例工厂",
      city_id: 7,
      is_active: true,
      created_at: "2026-10-23T00:00:00Z",
      updated_at: "2026-10-23T00:00:00Z",
      data_json: JSON.stringify({ address: "示例路 1 号", secret: "internal" }),
    });

    expect(factory).toEqual({
      id: 12,
      factory_name: "示例工厂",
      city_id: 7,
      is_active: true,
      address: "示例路 1 号",
      created_at: "2026-10-23T00:00:00Z",
      updated_at: "2026-10-23T00:00:00Z",
    });
  });

  it("projects the exact public service-position fields with stable primitive types", () => {
    const position = serializeServicePosition({
      id: 21,
      position_name: "示例岗位",
      featured: 1,
      created_at: "created",
      updated_at: "updated",
      data_json: JSON.stringify({ interview_days: ["周一"], interview_points: [{ name: "东门" }], base_sections: { positions: "装配" } }),
    });

    expect(Object.keys(position)).toHaveLength(29);
    expect(position).toMatchObject({
      id: 21,
      position_name: "示例岗位",
      interview_days: ["周一"],
      interview_points: [{ name: "东门" }],
      base_sections: { positions: "装配" },
      is_featured: true,
      is_active: true,
    });
    expect(typeof position.is_featured).toBe("boolean");
    expect(position).not.toHaveProperty("featured");
    expect(position).not.toHaveProperty("data_json");
    expect(Object.keys(position.base_sections as object)).toHaveLength(18);
    expect((position.base_sections as Record<string, unknown>).checkin_guide).toBe("");
  });

  it("serializes recruiter aliases and related cities without storage columns", () => {
    const recruiter = serializeRecruiter({
      id: 3,
      username: "agent-3",
      city_id: 7,
      status: "enabled",
      updated_at: "updated",
      created_at: "created",
      data_json: JSON.stringify({ description: "示例招聘员", llm_config: { model: "mock" }, sort_order: 4, recruiter_type: "service" }),
    }, [{ city_id: 7, city_name: "示例市", is_enabled: 1, sort_order: 2 }]);

    expect(recruiter).toEqual({
      id: 3,
      recruiter_id: "agent-3",
      name: "agent-3",
      description: "示例招聘员",
      recruiter_type: "service",
      is_active: true,
      sort_order: 4,
      llm_config: { model: "mock" },
      city_count: 1,
      cities: [{ id: 7, city_name: "示例市", is_enabled: true, sort_order: 2, recruiter_id: "agent-3" }],
      password_set: false,
      updated_at: "updated",
    });
  });

  it("serializes candidate fields and maps wechat_id from extension data", () => {
    const candidate = serializeCandidate({
      id: 5,
      device_code: "device-1",
      customer_id: "customer-1",
      nickname: "示例候选人",
      event_type: "invited",
      event_at: "event",
      name: "候选人甲",
      phone: "13800000000",
      interview_date: "2026-10-24",
      interview_time: "09:00",
      factory_name: "示例工厂",
      city: "示例市",
      district: "甲区",
      status: "invited",
      remind_count: 1,
      disqualified_reason: "",
      created_at: "created",
      updated_at: "internal",
      data_json: JSON.stringify({ wechat_id: "mock-wechat" }),
    });

    expect(candidate).toEqual({
      id: 5,
      device_code: "device-1",
      customer_id: "customer-1",
      nickname: "示例候选人",
      wechat_id: "mock-wechat",
      event_type: "invited",
      event_at: "event",
      name: "候选人甲",
      phone: "13800000000",
      interview_date: "2026-10-24",
      interview_time: "09:00",
      factory_name: "示例工厂",
      city: "示例市",
      district: "甲区",
      status: "invited",
      remind_count: 1,
      disqualified_reason: "",
      created_at: "created",
    });
  });

  it("keeps the observed nested timeout object and string queue state for devices", () => {
    const device = serializeAgentDevice({
      id: 9,
      device_name: "本地设备",
      created_at: "created",
      data_json: JSON.stringify({
        device_code: "device-9",
        name: "坐席九",
        online: true,
        queue_stale: "fresh",
        last_online: "2026-10-23T00:00:00Z",
        last_offline: "2026-10-22T00:00:00Z",
        config: {
          timeout: { enabled: true, interval_seconds: 30, max_count: 3, scripts: ["提醒"] },
          merge_delay_seconds: 2,
          merge_requery: false,
        },
      }),
    });

    expect(device).toMatchObject({
      device_code: "device-9",
      name: "坐席九",
      status: true,
      online: true,
      queue_stale: "fresh",
      last_online: "2026-10-23T00:00:00Z",
      last_offline: "2026-10-22T00:00:00Z",
      config: {
        timeout: { enabled: true, interval_seconds: 30, max_count: 3, scripts: ["提醒"] },
        merge_delay_seconds: 2,
        merge_requery: false,
      },
    });
    expect(typeof device.queue_stale).toBe("string");
    expect(typeof (device.config as Record<string, unknown>).timeout).toBe("object");
    expect(device).not.toHaveProperty("data_json");
  });

  it("normalizes city-link dictionaries without changing their public envelope", () => {
    expect(serializeCityLinks({ districts: { 示例市: ["甲区"] }, links: { "7": [12] } })).toEqual({
      districts: { 示例市: ["甲区"] },
      links: { "7": [12] },
    });
  });

  it("keeps evaluation and metrics collection envelopes stable", () => {
    expect(serializeEvaluationOverview({ days: 7, items: [] })).toEqual({ days: 7, items: [] });
    expect(serializeMetrics({ start_date: "2026-10-01", end_date: "2026-10-23", items: [] })).toEqual({
      start_date: "2026-10-01",
      end_date: "2026-10-23",
      items: [],
    });
  });

  it("serializes account summary totals with the observed metric keys", () => {
    expect(serializeAccountSummary({ prefix: "local", date_range: { start: "2026-10-01", end: "2026-10-23" } })).toEqual({
      prefix: "local",
      date_range: { start: "2026-10-01", end: "2026-10-23" },
      total: { checked_in: 0, device_count: 0, disqualified: 0, invite_rate: 0, invited: 0, new_conversations: 0, pending_invite: 0 },
      accounts: [],
      daily_trend: [],
    });
  });

  it("fills the observed state-distribution keys without inventing history rows", () => {
    const dashboard = serializeStatusDashboard({ devices: {}, messages: {}, queue: {}, errors: {} });

    expect(dashboard.state_distribution).toEqual({
      active: 0,
      disqualified: 0,
      followup_invite: 0,
      timeout_1: 0,
      timeout_2: 0,
      timeout_3: 0,
      waiting: 0,
    });
    expect(dashboard.daily_trend).toEqual([]);
    expect(dashboard.device_ranking).toEqual([]);
  });
});
