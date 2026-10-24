export interface DifyMessageInput {
  baseUrl: string;
  apiKey: string;
  user: string;
  query: string;
  conversationId?: string;
  inputs?: Record<string, unknown>;
}

export interface DifyMessageResult {
  success: boolean;
  message?: string;
  message_id?: string;
  conversation_id?: string;
  error?: string;
}

export interface DifyHealthResult {
  healthy: boolean;
  latency_ms: number;
  error?: string;
}

export interface DifyProvider {
  sendMessage(input: DifyMessageInput): Promise<DifyMessageResult>;
  healthCheck(input: Pick<DifyMessageInput, "baseUrl" | "apiKey">): Promise<DifyHealthResult>;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "Dify request timeout";
    return error.message.slice(0, 300);
  }
  return "Dify request failed";
}

export class MockDifyProvider implements DifyProvider {
  constructor(private readonly options: { response?: string; health?: boolean } = {}) {}

  async sendMessage(input: DifyMessageInput): Promise<DifyMessageResult> {
    return {
      success: true,
      message: this.options.response ?? `Mock response for ${input.user}`,
      message_id: `mock-${input.user}-${input.query.length}`,
      conversation_id: input.conversationId ?? `mock-conversation-${input.user}`,
    };
  }

  async healthCheck(_input: Pick<DifyMessageInput, "baseUrl" | "apiKey">): Promise<DifyHealthResult> {
    return { healthy: this.options.health ?? true, latency_ms: 0 };
  }
}

export class HttpDifyProvider implements DifyProvider {
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  async sendMessage(input: DifyMessageInput): Promise<DifyMessageResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}/chat-messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ inputs: input.inputs ?? {}, query: input.query, response_mode: "blocking", user: input.user, ...(input.conversationId ? { conversation_id: input.conversationId } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok) return { success: false, error: `Dify HTTP ${response.status}` };
      const body = await response.json() as { answer?: unknown; message_id?: unknown; conversation_id?: unknown };
      return {
        success: true,
        message: typeof body.answer === "string" ? body.answer : "",
        message_id: typeof body.message_id === "string" ? body.message_id : undefined,
        conversation_id: typeof body.conversation_id === "string" ? body.conversation_id : undefined,
      };
    } catch (error) {
      return { success: false, error: safeError(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(input: Pick<DifyMessageInput, "baseUrl" | "apiKey">): Promise<DifyHealthResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}/parameters`, {
        method: "GET",
        headers: { authorization: `Bearer ${input.apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return { healthy: false, latency_ms: Date.now() - started, error: `Dify HTTP ${response.status}` };
      return { healthy: true, latency_ms: Date.now() - started };
    } catch (error) {
      return { healthy: false, latency_ms: Date.now() - started, error: safeError(error) };
    } finally {
      clearTimeout(timeout);
    }
  }
}
