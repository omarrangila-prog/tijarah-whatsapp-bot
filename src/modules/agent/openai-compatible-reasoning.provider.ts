import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../common/services/logger.service';
import { openAiBaseUrl } from './ai-base-url';
import type {
  ReasoningMessage,
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  ReasoningToolCall,
} from './agent-reasoning.interface';

/**
 * Any host that speaks OpenAI's chat-completions API, as the agent's reasoner.
 *
 * One provider rather than one per vendor, because Moonshot (Kimi), DeepSeek, Together,
 * Groq, OpenRouter, vLLM, Ollama and LiteLLM all expose the same three things: a
 * `/chat/completions` endpoint, a bearer token, and tool calls in OpenAI's shape. Pointing
 * this at a different host is a change to `AI_BASE_URL`, not a code change — which is the
 * whole reason it is written this way. Nothing here is specific to a vendor.
 *
 * It implements the same `ReasoningProvider` seam as Gemini, so the tools, the permission
 * layer and the audit trail are identical whichever one answers.
 *
 * **The base URL is deliberately not defaulted.** A default would mean a misconfigured
 * deployment silently sent a customer's ledger to whatever host happened to be baked in.
 * Unset, this provider reports itself unavailable and the runtime moves on.
 */
@Injectable()
export class OpenAiCompatibleReasoningProvider implements ReasoningProvider {
  readonly id = 'openai-compatible';
  private readonly logger = createLogger('OpenAiCompatibleReasoning');

  /**
   * No fallback model.
   *
   * Every host serves different names — `kimi-k2`, `deepseek-chat`,
   * `moonshot-v1-8k` — so a guess would produce a 404 that reads like a broken
   * integration. If the operator named a host, they must name the model on it.
   */
  get model(): string | null {
    return process.env.AI_MODEL?.trim() || null;
  }

  /** A bare host gets `/v1`: see ai-base-url.ts for the gateway that answered with a web page. */
  private get baseUrl(): string | null {
    return openAiBaseUrl(process.env.AI_BASE_URL);
  }

  private get apiKey(): string | null {
    const key = process.env.AI_API_KEY?.trim();
    return key && key.length > 0 ? key : null;
  }

  /** All three, or nothing: a half-configured reasoner is worse than an absent one. */
  isAvailable(): boolean {
    return this.baseUrl !== null && this.apiKey !== null && this.model !== null;
  }

  /**
   * The conversation in OpenAI's shape.
   *
   * The system prompt is a message with `role: 'system'` rather than its own field, which is
   * the main difference from Gemini. A tool result is its own `role: 'tool'` message carrying
   * the `tool_call_id` it answers — so unlike Gemini there is no need to dress it up as a
   * user turn.
   */
  private toMessages(system: string, messages: ReasoningMessage[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

    for (const message of messages) {
      if (message.role === 'user') {
        out.push({ role: 'user', content: message.content });
        continue;
      }
      if (message.role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          /*
           * Errors are reported, not hidden. Telling the model a call was refused is what
           * lets it explain the refusal to the person instead of silently trying something
           * else — and "something else" from a model that does not know it was blocked is
           * how a fence gets probed.
           */
          content: message.isError === true ? `ERROR: ${message.content}` : message.content,
        });
        continue;
      }

      const assistant: Record<string, unknown> = { role: 'assistant', content: message.content || null };
      if (message.toolCalls?.length) {
        assistant.tool_calls = message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
      }
      out.push(assistant);
    }

    return out;
  }

  async reason(input: ReasoningRequest): Promise<ReasoningResponse> {
    const baseUrl = this.baseUrl;
    const key = this.apiKey;
    const model = this.model;
    if (!baseUrl || !key || !model) {
      throw new Error('AI_BASE_URL, AI_API_KEY and AI_MODEL must all be set.');
    }

    const body: Record<string, unknown> = {
      model,
      messages: this.toMessages(input.system, input.messages),
      max_tokens: input.maxTokens ?? 1024,
      // Low, for the same reason as Gemini: this picks tools and writes short replies about
      // money. Invention is the failure mode, not dullness.
      temperature: 0.2,
      // Streaming is pointless here — a WhatsApp reply is sent once, whole.
      stream: false,
    };

    if (input.tools.length) {
      /*
       * Schemas are passed through untouched.
       *
       * Unlike Gemini, which takes a small OpenAPI subset and rejects the entire request on
       * the first keyword it does not know, OpenAI's tool format accepts standard JSON Schema
       * — so the zod output needs no reduction. A host that is stricter than the spec will
       * say so in its error body, which is surfaced below rather than swallowed.
       */
      body.tools = input.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description.slice(0, 1024),
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = 'auto';
    }

    const res = await request(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
    });

    const text = await res.body.text();
    if (res.statusCode >= 400) {
      /*
       * Truncated, and the host is named.
       *
       * Naming it matters when several hosts are interchangeable: "responded 401" without a
       * host sends whoever is on call to check the wrong key. The body cannot contain the
       * key, which is a header.
       */
      throw new Error(`${baseUrl} responded ${res.statusCode}: ${text.slice(0, 200)}`);
    }

    /*
     * A web page is not an answer. Some gateways serve their site, with a 200, on any path they
     * do not route — so a wrong base URL looked like a model that returned garbage. Said plainly,
     * it is fixable from the status screen.
     */
    if (/^\s*</.test(text)) {
      throw new Error(`${baseUrl}/chat/completions returned a web page, not JSON — check AI_BASE_URL`);
    }

    const parsed = JSON.parse(text) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = parsed.choices?.[0]?.message;
    const toolCalls: ReasoningToolCall[] = [];

    for (const call of message?.tool_calls ?? []) {
      if (!call.function?.name) continue;
      toolCalls.push({
        // Some hosts omit the id on a single call; the runtime needs one to match the result
        // back, so a generated one is better than an empty string that collides.
        id: call.id?.trim() || `call_${randomUUID().slice(0, 8)}`,
        name: call.function.name,
        input: parseArguments(call.function.arguments, call.function.name, this.logger),
      });
    }

    const said = message?.content?.trim() ?? '';

    return {
      text: said,
      toolCalls,
      // A turn that asked for a tool is not finished; the runtime runs it and comes back.
      finished: toolCalls.length === 0,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      model,
    };
  }
}

/**
 * Tool arguments, which arrive as a JSON **string**.
 *
 * Models emit malformed JSON often enough that this cannot throw: an exception here would
 * abort the whole turn and the person would see "something went wrong" because a model
 * forgot a brace. An empty input instead reaches the tool's own zod schema, which refuses it
 * with a message naming the missing field — and the model, told that, usually fixes it on the
 * next hop.
 */
function parseArguments(
  raw: string | undefined,
  toolName: string,
  logger: { warn: (message: string) => void },
): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    logger.warn(`${toolName} was called with arguments that are not valid JSON; treating as empty`);
    return {};
  }
}
