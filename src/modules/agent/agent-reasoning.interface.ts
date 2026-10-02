/**
 * Tool-calling, added to the existing AI seam rather than beside it.
 *
 * `AiProvider` (in command-center/ai) is text-in/text-out, which is all the copilot ever
 * needed — analyze, suggest a reply, translate. An agent turn needs something the copilot
 * never did: the ability to be handed a list of tools, to ask for one, to be given the
 * result, and to continue.
 *
 * This is expressed as a *separate optional capability* on the same providers rather than
 * as a second provider stack. A provider that can do tool calls implements it; one that
 * cannot is still perfectly useful for the copilot and simply cannot host an agent turn.
 * The alternative — a parallel LLM client for WhatsApp — is exactly the duplication the
 * brief rules out, and would mean two places to configure a key, two places to rotate it,
 * and two sets of usage to reconcile.
 */

export interface ReasoningTool {
  name: string;
  description: string;
  /** JSON Schema. Produced from the registry's zod schemas, so there is one source. */
  inputSchema: Record<string, unknown>;
}

export interface ReasoningToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ReasoningMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ReasoningToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

export interface ReasoningRequest {
  /** Trusted instructions. Never contains channel input — see `fenceUntrusted`. */
  system: string;
  messages: ReasoningMessage[];
  tools: ReasoningTool[];
  maxTokens?: number;
  /**
   * Who is talking, resolved before the model runs.
   *
   * A model-backed provider ignores this — the system prompt already says it. The rule-based
   * provider needs it explicitly, because it has no language model to infer audience from
   * prose, and without it a customer receives the operator help text: internal command
   * vocabulary, sent to a member of the public. Passing it on the request keeps that need
   * from leaking upward as a second entry point.
   */
  context?: {
    senderRole: 'admin' | 'staff' | 'client' | 'customer' | 'unknown';
    /**
     * Whether this person is part-way through composing a document.
     *
     * The rule-based provider has no memory of the conversation, so without this it cannot
     * tell "Ali Traders" — the answer to a question it asked a moment ago — from an
     * unrecognised instruction, and answers the help text instead.
     */
    hasOpenDraft?: boolean;
  };
}

export interface ReasoningResponse {
  /** What the model said, if anything. May be empty when it only asked for tools. */
  text: string;
  toolCalls: ReasoningToolCall[];
  /** True when the model is done and wants no more tools. */
  finished: boolean;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Implemented by providers that can host an agent turn.
 *
 * Kept structural so a provider opts in by having the method, and the runtime checks with
 * `supportsReasoning()` rather than by class name.
 */
export interface ReasoningProvider {
  readonly id: string;
  readonly model: string | null;
  isAvailable(): boolean;
  reason(request: ReasoningRequest): Promise<ReasoningResponse>;
}

export function supportsReasoning(provider: unknown): provider is ReasoningProvider {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    typeof (provider as ReasoningProvider).reason === 'function' &&
    typeof (provider as ReasoningProvider).isAvailable === 'function'
  );
}

/** DI token for the ordered reasoning-capable provider list, most preferred first. */
export const REASONING_PROVIDERS = Symbol('REASONING_PROVIDERS');
