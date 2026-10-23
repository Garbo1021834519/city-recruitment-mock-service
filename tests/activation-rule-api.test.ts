import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";

const DAY = 86_400_000;
const isoAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const dateFromToday = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

describe("activation strategy rule API", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let token = "";
  const headers = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    db = (app as FastifyInstance & { db: DatabaseSync }).db;
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
  });

  afterAll(async () => { await app.close(); });

  it("persists a strategy by its UI code and reports candidate-level match details", async () => {
    db.prepare("INSERT INTO agent_conversations(device_code,customer_id,created_at,last_msg_at) VALUES (?,?,?,?)")
      .run("rule-device", 101, isoAgo(3), isoAgo(3));
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,created_at) VALUES (?,?,?,?,?)")
      .run("rule-device", 101, "outbound", "岗位资料", isoAgo(2));

    const update = await app.inject({
      method: "PUT",
      url: "/api/v1/activation/strategies/no_reply",
      headers: headers(),
      payload: { enabled: true, stale_days: 1, stale_days_max: 3, daily_limit: 17 },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ code: "no_reply", enabled: true, stale_days: 1, stale_days_max: 3, daily_limit: 17 });

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/activation/strategies/no_reply/test",
      headers: headers(),
      payload: { customer_id: "101" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ strategy_id: "no_reply", customer_id: "101", matched: true, eligible: true, reason: "customer_silent_after_outbound" });
    expect(preview.json().next_push_at).toEqual(expect.any(String));
    expect(preview.json().summary).toContain("客户最后一条消息由坐席发送");

    const list = await app.inject({ method: "GET", url: "/api/v1/activation/strategies", headers: headers() });
    const publicStrategy = list.json().items.find((item: { code: string }) => item.code === "no_reply");
    expect(publicStrategy).toMatchObject({ enabled: true, daily_limit: 17 });
    expect(publicStrategy).not.toHaveProperty("conversation_max_days");
    expect(list.json().engine).not.toHaveProperty("paused");
  });

  it("uses invitation, disqualification, and pause evidence for the other strategies", async () => {
    db.prepare("INSERT INTO candidate_events(customer_id,event_type,event_at,interview_date,status) VALUES (?,?,?,?,?)")
      .run("202", "invited", isoAgo(1), dateFromToday(1), "invited");
    db.prepare("INSERT INTO candidate_events(customer_id,event_type,event_at,status) VALUES (?,?,?,?)")
      .run("303", "disqualified", isoAgo(1), "disqualified");
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,created_at) VALUES (?,?,?,?,?)")
      .run("rule-device", 303, "inbound", "我还想看看", isoAgo(0.5));
    db.prepare("INSERT INTO agent_conversations(device_code,customer_id,created_at,last_msg_at) VALUES (?,?,?,?)")
      .run("rule-device", 404, isoAgo(12), isoAgo(6));
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,created_at) VALUES (?,?,?,?,?)")
      .run("rule-device", 404, "inbound", "我过几天回广州再联系", isoAgo(6));

    for (const code of ["date_trigger", "misjudge", "paused"]) {
      const update = await app.inject({ method: "PUT", url: `/api/v1/activation/strategies/${code}`, headers: headers(), payload: { enabled: true } });
      expect(update.statusCode).toBe(200);
    }

    const results = await Promise.all([202, 303, 404].map((customerId, index) => app.inject({
      method: "POST",
      url: `/api/v1/activation/strategies/${["date_trigger", "misjudge", "paused"][index]}/test`,
      headers: headers(),
      payload: { customer_id: String(customerId) },
    })));
    expect(results.map((result) => result.json())).toEqual(expect.arrayContaining([
      expect.objectContaining({ strategy_id: "date_trigger", matched: true, eligible: true, reason: "interview_in_activation_window" }),
      expect.objectContaining({ strategy_id: "misjudge", matched: true, eligible: true, reason: "inbound_after_disqualification" }),
      expect.objectContaining({ strategy_id: "paused", matched: true, eligible: true, reason: "pause_phrase_and_quiet_period" }),
    ]));
  });

  it("honors global pause and candidate cooldown without changing the match result", async () => {
    db.prepare("INSERT INTO agent_conversations(device_code,customer_id,created_at) VALUES (?,?,?)")
      .run("rule-device", 505, isoAgo(3));
    db.prepare("INSERT INTO agent_messages(device_code,customer_id,direction,content,created_at) VALUES (?,?,?,?,?)")
      .run("rule-device", 505, "outbound", "岗位资料", isoAgo(2));
    db.prepare("INSERT INTO activation_records(customer_id,strategy,created_at,status) VALUES (?,?,?,?)")
      .run(505, "no_reply", isoAgo(1), "sent");

    const cooldown = await app.inject({ method: "POST", url: "/api/v1/activation/strategies/no_reply/test", headers: headers(), payload: { customer_id: "505" } });
    expect(cooldown.json()).toMatchObject({ matched: true, eligible: false, reason: "cooldown_active" });

    await app.inject({ method: "PUT", url: "/api/v1/activation/config/paused", headers: headers(), payload: { paused: true } });
    const paused = await app.inject({ method: "POST", url: "/api/v1/activation/strategies/no_reply/test", headers: headers(), payload: { customer_id: "505" } });
    expect(paused.json()).toMatchObject({ matched: true, eligible: false, reason: "activation_paused", next_push_at: null });
  });

  it("rejects unknown strategy codes and test previews without a customer id", async () => {
    const unknown = await app.inject({ method: "POST", url: "/api/v1/activation/strategies/not-a-rule/test", headers: headers(), payload: { customer_id: "101" } });
    const missingCustomer = await app.inject({ method: "POST", url: "/api/v1/activation/strategies/no_reply/test", headers: headers(), payload: {} });
    expect(unknown.statusCode).toBe(404);
    expect(missingCustomer.statusCode).toBe(422);
  });
});
