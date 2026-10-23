import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { buildServer } from "../src/server.js";

describe("unknown question conversion", () => {
  let app: FastifyInstance;
  let token = "";
  let db: DatabaseSync;

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    db = (app as FastifyInstance & { db: DatabaseSync }).db;
    token = (await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    })).json().access_token;
  });

  afterAll(async () => { await app.close(); });

  async function createQuestion(question: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/unknown-questions",
      headers: { authorization: `Bearer ${token}` },
      payload: { question, status: "pending", count: 2, city_name: "广州" },
    });
    expect(response.statusCode).toBe(200);
    return response.json().id as number;
  }

  it("converts a pending question into a visible knowledge item and records the link", async () => {
    const id = await createQuestion("报名需要什么资料");
    const columns = db.prepare("PRAGMA table_info(unknown_questions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["converted_knowledge_id", "converted_at"]));

    const converted = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { question: "报名需要什么资料", answer: "身份证和本人银行卡", keywords: ["报名", "资料"] },
    });

    expect(converted.statusCode).toBe(200);
    expect(converted.json()).toMatchObject({
      question: "报名需要什么资料",
      keywords: ["报名", "资料"],
      is_active: true,
      sort_order: 0,
    });
    expect(converted.json()).not.toHaveProperty("data_json");

    const knowledge = await app.inject({
      method: "GET",
      url: "/api/v1/knowledge?page=1&page_size=20",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(knowledge.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      question: "报名需要什么资料",
      keywords: ["报名", "资料"],
      is_active: true,
    })]));

    const original = await app.inject({
      method: "GET",
      url: `/api/v1/unknown-questions/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(original.json()).toMatchObject({ id, question: "报名需要什么资料", status: "resolved" });
    expect(original.json()).not.toHaveProperty("converted_knowledge_id");

    const stored = db.prepare("SELECT converted_knowledge_id,converted_at FROM unknown_questions WHERE id=?").get(id) as { converted_knowledge_id: number; converted_at: string };
    expect(stored.converted_knowledge_id).toBe(converted.json().id);
    expect(stored.converted_at).toEqual(expect.any(String));
  });

  it("rejects missing, duplicate, and invalid-answer conversions without changing the source", async () => {
    const id = await createQuestion("工作时间是多久");
    const headers = { authorization: `Bearer ${token}` };
    const missing = await app.inject({ method: "POST", url: "/api/v1/unknown-questions/999999/convert", headers, payload: { question: "x", answer: "y" } });
    expect(missing.statusCode).toBe(404);

    const noAnswer = await app.inject({ method: "POST", url: `/api/v1/unknown-questions/${id}/convert`, headers, payload: { question: "工作时间是多久" } });
    expect(noAnswer.statusCode).toBe(422);

    const blankAnswer = await app.inject({ method: "POST", url: `/api/v1/unknown-questions/${id}/convert`, headers, payload: { question: "工作时间是多久", answer: "   " } });
    expect(blankAnswer.statusCode).toBe(422);

    const first = await app.inject({ method: "POST", url: `/api/v1/unknown-questions/${id}/convert`, headers, payload: { question: "工作时间是多久", answer: "每天八小时" } });
    expect(first.statusCode).toBe(200);
    const repeated = await app.inject({ method: "POST", url: `/api/v1/unknown-questions/${id}/convert`, headers, payload: { question: "工作时间是多久", answer: "每天八小时" } });
    expect(repeated.statusCode).toBe(409);

    const stored = db.prepare("SELECT status FROM unknown_questions WHERE id=?").get(id) as { status: string };
    expect(stored.status).toBe("resolved");
  });

  it("rolls back both the knowledge insert and source transition if insertion fails", async () => {
    const id = await createQuestion("事务失败测试");
    db.exec("CREATE TRIGGER fail_conversion BEFORE INSERT ON knowledge_items WHEN NEW.title='事务失败测试' BEGIN SELECT RAISE(ABORT,'simulated insert failure'); END");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { question: "事务失败测试", answer: "必须回滚" },
    });

    expect(response.statusCode).toBe(500);
    expect((db.prepare("SELECT status,converted_knowledge_id FROM unknown_questions WHERE id=?").get(id) as { status: string; converted_knowledge_id: number | null })).toEqual({ status: "pending", converted_knowledge_id: null });
    expect((db.prepare("SELECT COUNT(*) count FROM knowledge_items WHERE title='事务失败测试'").get() as { count: number }).count).toBe(0);
  });

  it("rolls back the knowledge insert if the source transition affects no row", async () => {
    const id = await createQuestion("来源状态更新失败");
    db.exec(`CREATE TRIGGER skip_source_transition BEFORE UPDATE OF status ON unknown_questions WHEN OLD.id=${id} BEGIN SELECT RAISE(IGNORE); END`);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/unknown-questions/${id}/convert`,
      headers: { authorization: `Bearer ${token}` },
      payload: { question: "来源状态更新失败", answer: "必须原子完成" },
    });

    expect(response.statusCode).toBe(500);
    expect((db.prepare("SELECT status,converted_knowledge_id FROM unknown_questions WHERE id=?").get(id) as { status: string; converted_knowledge_id: number | null })).toEqual({ status: "pending", converted_knowledge_id: null });
    expect((db.prepare("SELECT COUNT(*) count FROM knowledge_items WHERE title='来源状态更新失败'").get() as { count: number }).count).toBe(0);
  });
});
