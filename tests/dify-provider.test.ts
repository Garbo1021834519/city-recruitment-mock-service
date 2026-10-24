import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { HttpDifyProvider, MockDifyProvider, type DifyMessageInput } from "../src/modules/dify/dify-provider.js";

const input: DifyMessageInput = {
  baseUrl: "https://dify.example.invalid/v1",
  apiKey: "secret-test-key",
  user: "customer-501",
  query: "你好，请推荐岗位",
  conversationId: "conversation-1",
};

describe("Dify providers", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("mock provider returns a deterministic message result and healthy status", async () => {
    const provider = new MockDifyProvider({ response: "本地模拟回复" });
    await expect(provider.sendMessage(input)).resolves.toMatchObject({ success: true, message: "本地模拟回复" });
    await expect(provider.healthCheck(input)).resolves.toEqual({ healthy: true, latency_ms: expect.any(Number) });
  });

  it("HTTP provider sends the Dify chat request and maps the response", async () => {
    let received: { authorization?: string; body?: Record<string, unknown> } = {};
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ answer: "HTTP 回复", message_id: "msg-1", conversation_id: "conversation-2" }));
      });
    }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpDifyProvider({ timeoutMs: 2_000 });
    const result = await provider.sendMessage({ ...input, baseUrl: `http://127.0.0.1:${address.port}` });

    expect(result).toEqual({ success: true, message: "HTTP 回复", message_id: "msg-1", conversation_id: "conversation-2" });
    expect(received.authorization).toBe("Bearer secret-test-key");
    expect(received.body).toMatchObject({ inputs: {}, query: input.query, user: input.user, response_mode: "blocking" });
  });

  it("HTTP provider returns a safe error for non-2xx responses without echoing the key", async () => {
    server = createServer((_request, response) => { response.statusCode = 503; response.end("upstream unavailable"); }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpDifyProvider({ timeoutMs: 2_000 });
    const result = await provider.sendMessage({ ...input, baseUrl: `http://127.0.0.1:${address.port}` });

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 503");
    expect(result.error).not.toContain(input.apiKey);
  });

  it("HTTP provider reports timeouts and unhealthy health checks", async () => {
    server = createServer(() => { /* intentionally never responds */ }).listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const provider = new HttpDifyProvider({ timeoutMs: 30 });
    const result = await provider.sendMessage({ ...input, baseUrl: `http://127.0.0.1:${address.port}` });
    const health = await provider.healthCheck({ ...input, baseUrl: `http://127.0.0.1:${address.port}` });

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("timeout");
    expect(health).toMatchObject({ healthy: false, error: expect.any(String) });
  });
});
