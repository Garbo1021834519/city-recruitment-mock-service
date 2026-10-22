import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("observed role boundaries", () => {
  let app: FastifyInstance;
  beforeAll(async () => { process.env.REA_DATABASE_PATH = ":memory:"; app = buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });
  async function token(username: string) { return (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "local-demo-only" } })).json().access_token; }
  it("keeps users admin-only and recruiter-featured recruiter-only", async () => {
    const admin = await token("local-admin");
    const customer = await token("local-customer");
    const recruiter = await token("local-recruiter");
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: { authorization: `Bearer ${customer}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/recruiter-featured/cities", headers: { authorization: `Bearer ${customer}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/recruiter-featured/cities", headers: { authorization: `Bearer ${recruiter}` } })).statusCode).toBe(200);
  });
});
