import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../common/services/logger.service';
import type {
  ReasoningMessage,
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  ReasoningToolCall,
} from './agent-reasoning.interface';

/**
 * Google Gemini as the agent's reasoner.
 *
 * Chosen because its free tier is enough to run this: one key, no card, and generous enough
 * limits for a bot answering a handful of staff. It implements the same `ReasoningProvider`
 * seam as the Anthropic provider — the runtime picks whichever is available and the tools,
 * permissions and audit trail are identical either way.
 *
 * Gemini's REST shape differs from Anthropic's in three ways that matter, and each is handled
 * below rather than papered over: the system prompt is its own field, tool results are
 * `functionResponse` parts inside a `user` turn, and a model turn can carry text and function
 * calls together.
 */
@Injectable()
export class GeminiReasoningProvider implements ReasoningProvider {
  readonly id = 'gemini';
  private readonly logger = createLogger('GeminiReasoning');

  /**
   * Default kept current deliberately.
   *
   * Google retires models and answers a retired one with a 404 that names the replacement —
   * which reads like a broken integration rather than an expired default. `gemini-2.0-flash`
   * is already gone; override with GEMINI_MODEL when this one follows it.
   */
  get model(): string | null {
    return process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash';
  }

  private get apiKey(): string | null {
    const key = process.env.GEMINI_API_KEY?.trim();
    return key && key.length > 0 ? key : null;
  }

  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Gemini takes a flat `contents` array with no system role.
   *
   * A tool result is a `functionResponse` part on a `user` turn, which reads oddly but is the
   * documented shape: the model's own `functionCall` is the assistant turn, and what came back
   * is presented as the user replying with the answer.
   */
  private toContents(messages: ReasoningMessage[]): Array<Record<string, unknown>> {
    return messages.map(message => {
      if (message.role === 'user') {
        return { role: 'user', parts: [{ text: message.content }] };
      }
      if (message.role === 'tool') {
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: message.toolCallId,
                // The whole result, error or not. Telling the model a call failed is what lets
                // it explain the refusal rather than silently trying something else.
                response: { result: message.content, isError: message.isError === true },
              },
            },
          ],
        };
      }

      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      return { role: 'model', parts: parts.length ? parts : [{ text: '' }] };
    });
  }

  /**
   * Reduces a JSON Schema to the subset Gemini accepts.
   *
   * An allowlist, not a denylist. Gemini takes a small OpenAPI-flavoured subset and rejects
   * the whole request — every tool, not just the offending one — on the first keyword it does
   * not know, with a 400 that names a numeric path rather than a tool. Removing keywords one
   * at a time as they surface is a losing game: `$schema` and `additionalProperties` were the
   * obvious ones, `propertyNames` only appeared once a tool used `z.record`, and the next zod
   * feature would have failed the same way in production.
   */
  private toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const ALLOWED = new Set([
      'type',
      'format',
      'description',
      'nullable',
      'enum',
      'items',
      'properties',
      'required',
      'minItems',
      'maxItems',
    ]);

    const clean = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clean);
      if (!value || typeof value !== 'object') return value;

      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(source)) {
        if (!ALLOWED.has(key)) continue;
        // `properties` is a map of names to schemas, so its VALUES are cleaned but its keys
        // are field names and must survive untouched.
        out[key] = key === 'properties' ? cleanProperties(inner) : clean(inner);
      }

      /*
       * A free-form object with no declared properties is invalid to Gemini. `z.record(...)`
       * produces exactly that, and describing it as a plain string is closer to the truth than
       * omitting the parameter: the model can still pass JSON, and the tool's own zod schema
       * validates it properly on the way in.
       */
      if (out.type === 'object' && !out.properties) {
        const described = typeof out.description === 'string' ? out.description : 'JSON object';
        return { type: 'string', description: described };
      }
      return out;
    };

    const cleanProperties = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object') return {};
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, inner]) => [name, clean(inner)]),
      );
    };

    return clean(schema) as Record<string, unknown>;
  }

  async reason(input: ReasoningRequest): Promise<ReasoningResponse> {
    const key = this.apiKey;
    if (!key) throw new Error('GEMINI_API_KEY is not set.');

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: this.toContents(input.messages),
      generationConfig: { maxOutputTokens: input.maxTokens ?? 1024, temperature: 0.2 },
    };

    if (input.tools.length) {
      body.tools = [
        {
          functionDeclarations: input.tools.map(tool => ({
            name: tool.name,
            description: tool.description.slice(0, 1024),
            parameters: this.toGeminiSchema(tool.inputSchema),
          })),
        },
      ];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model ?? '')}:generateContent`;

    const res = await request(url, {
      method: 'POST',
      // The key goes in a header, not the query string: a URL ends up in logs and proxies.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
    });

    const text = await res.body.text();
    if (res.statusCode >= 400) {
      // Truncated and never echoing the key, which is a header rather than part of the body.
      throw new Error(`Gemini responded ${res.statusCode}: ${text.slice(0, 200)}`);
    }

    const parsed = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    const said: string[] = [];
    const toolCalls: ReasoningToolCall[] = [];

    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.trim()) said.push(part.text);
      const call = part.functionCall as { name?: string; args?: Record<string, unknown> } | undefined;
      if (call?.name) {
        /*
         * Gemini does not give a call an id, but the runtime needs one to match a result back.
         * The tool's own name is used, because that is what a `functionResponse` is keyed on
         * when the conversation continues.
         */
        toolCalls.push({ id: call.name, name: call.name, input: call.args ?? {} });
      }
    }

    if (!said.length && !toolCalls.length) {
      this.logger.warn(
        `Gemini returned nothing usable (finishReason=${parsed.candidates?.[0]?.finishReason ?? 'none'})`,
      );
    }

    return {
      text: said.join('\n').trim(),
      toolCalls,
      // Finished when it asked for no tools: there is nothing left to feed back.
      finished: toolCalls.length === 0,
      inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      model: this.model ?? 'gemini',
    };
  }

  /** Unused id generator kept out of the hot path; here so tests can stub call ids. */
  static newCallId(): string {
    return `gem_${randomUUID().slice(0, 8)}`;
  }
}
