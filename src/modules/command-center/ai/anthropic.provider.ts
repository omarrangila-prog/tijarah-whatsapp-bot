import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiCompletionRequest, AiProvider } from './ai-provider.interface';
import { anthropicBaseUrl } from '../../agent/ai-base-url';
import type {
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  ReasoningToolCall,
} from '../../agent/agent-reasoning.interface';

/**
 * Claude-backed provider.
 *
 * The client is constructed lazily on first use rather than in the constructor: this provider is
 * always registered (so it can be enabled by setting an env var without a code change), and a
 * deployment that never configures a key must not pay for constructing a client it will not call.
 */
@Injectable()
export class AnthropicAiProvider implements AiProvider, ReasoningProvider {
  readonly id = 'anthropic';

  private client?: Anthropic;

  constructor(private readonly config: ConfigService) {}

  get model(): string {
    return this.config.get<string>('ai.model', 'claude-opus-5');
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: AiCompletionRequest): Promise<string> {
    const client = this.resolveClient();
    const response = await client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 2048,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    });

    // `content` is a discriminated union; only text blocks carry a body. Joining rather than taking
    // the first block means a response split across blocks is not silently truncated.
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
  }

  /**
   * One agent step: hand the model the tools, get back text and/or tool calls.
   *
   * A single round trip, deliberately. The loop that feeds results back and calls again
   * lives in `AgentRuntime`, because that is where the permission checks between steps
   * belong — a provider that ran the whole loop itself would be executing tools, and the
   * one thing this architecture does not allow is a model with a direct line to an engine.
   */
  async reason(request: ReasoningRequest): Promise<ReasoningResponse> {
    const client = this.resolveClient();
    const response = await client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 2048,
      system: request.system,
      tools: request.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
      })),
      messages: request.messages.map(toAnthropicMessage),
    });

    const toolCalls: ReasoningToolCall[] = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      }));

    return {
      text: response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim(),
      toolCalls,
      // `tool_use` means it wants to continue; anything else means it has finished talking.
      finished: response.stop_reason !== 'tool_use',
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      model: response.model ?? this.model,
    };
  }

  private get apiKey(): string | undefined {
    const key = this.config.get<string>('ai.apiKey');
    return key && key.trim() ? key.trim() : undefined;
  }

  private resolveClient(): Anthropic {
    if (!this.client) {
      const apiKey = this.apiKey;
      if (!apiKey) throw new Error('Anthropic provider is not configured');
      // Without a trailing /v1: the SDK adds its own, and "/v1/v1/messages" is a 404.
      const baseURL = anthropicBaseUrl(this.config.get<string>('ai.baseUrl'));
      this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    }
    return this.client;
  }
}

/**
 * Maps the provider-neutral message shape onto the SDK's.
 *
 * A tool result is a `user` turn carrying `tool_result` blocks, which is not obvious and is
 * the detail that most often produces a 400 from the API when hand-rolled.
 */
function toAnthropicMessage(message: ReasoningRequest['messages'][number]): Anthropic.MessageParam {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
        },
      ],
    };
  }

  if (message.role === 'assistant') {
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (message.content) blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    // An assistant turn with no blocks at all is rejected by the API; a space is harmless.
    return { role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: ' ' }] };
  }

  return { role: 'user', content: message.content };
}
