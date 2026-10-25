export interface OutboundMessageInput {
  deviceCode: string;
  customerId: number;
  content: string;
  idempotencyKey: string;
}

export interface OutboundMessageResult {
  success: boolean;
  message_id?: string;
  simulated?: boolean;
  error?: string;
}

export interface MessageChannelProvider {
  sendMessage(input: OutboundMessageInput): Promise<OutboundMessageResult>;
}

export class MockMessageChannelProvider implements MessageChannelProvider {
  async sendMessage(input: OutboundMessageInput): Promise<OutboundMessageResult> {
    return {
      success: true,
      message_id: `mock-${input.deviceCode}-${input.customerId}`,
      simulated: true,
    };
  }
}

export function createMessageChannelProvider(mode = process.env.REA_MESSAGE_CHANNEL_PROVIDER ?? "mock"): MessageChannelProvider {
  if (mode === "mock") return new MockMessageChannelProvider();
  throw new Error(`Unsupported message channel provider: ${mode}`);
}
