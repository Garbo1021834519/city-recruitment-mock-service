import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("core CRUD modules", () => {
  let app: FastifyInstance;
  let token = "";
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    token = login.json().access_token;
  });
  afterAll(async () => { await app.close(); });

  it("lists cities with items and creates a city", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/cities?page=1&page_size=100", headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ city_name: "广州" })]));
    expect(list.json().items[0]).not.toHaveProperty("data_json");
    // "深圳" and "东莞" are already seeded as mock fixtures, so this test uses a
    // city name not present in seed.ts to avoid the UNIQUE(city_name) collision.
    const created = await app.inject({ method: "POST", url: "/api/v1/cities", headers: { authorization: `Bearer ${token}` }, payload: { city_name: "佛山", province: "广东" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ city_name: "佛山", province: "广东" });
  });

  it("lists factories and service positions with filter fields", async () => {
    const factories = await app.inject({ method: "GET", url: "/api/v1/factories", headers: { authorization: `Bearer ${token}` } });
    expect(factories.statusCode).toBe(200);
    expect(factories.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ factory_name: "本地示例工厂" })]));
    expect(typeof factories.json().items[0].is_active).toBe("boolean");
    expect(factories.json().items[0]).not.toHaveProperty("data_json");
    const positions = await app.inject({ method: "GET", url: "/api/v1/service-positions?page_size=1000&city_name=广州", headers: { authorization: `Bearer ${token}` } });
    expect(positions.statusCode).toBe(200);
    expect(positions.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ position_name: "本地示例岗位" })]));
    expect(typeof positions.json().items[0].is_featured).toBe("boolean");
    expect(positions.json().items[0]).not.toHaveProperty("featured");
  });

  it("updates city status and toggles a featured service position", async () => {
    const city = await app.inject({ method: "PATCH", url: "/api/v1/cities/1/status", headers: { authorization: `Bearer ${token}` }, payload: { recruitment_status: "inactive" } });
    expect(city.statusCode).toBe(200);
    expect(city.json().recruitment_status).toBe("inactive");
    const position = await app.inject({ method: "PUT", url: "/api/v1/service-positions/1/toggle-featured", headers: { authorization: `Bearer ${token}` } });
    expect(position.statusCode).toBe(200);
    expect(position.json().is_featured).toBe(true);
  });
});
