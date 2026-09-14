/**
 * The AI seam.
 *
 * Business logic depends on this interface only — never on a vendor SDK. A provider is asked for a
 * completion and returns text; everything above it (prompt construction, JSON parsing, caching,
 * failure handling) is provider-neutral and lives in `AiService`. Swapping vendors, or running with
 * no vendor at all, changes which class is registered and nothing else.
 */
export type AiTask = 'analyze' | 'handoff' | 'suggest_reply' | 'rewrite' | 'shorten' | 'translate';

export interface AiCompletionRequest {
  /**
   * Which copilot function is being asked for.
   *
   * A model-backed provider ignores this — the system prompt already says everything. The offline
   * provider needs it, because it has no language model to infer intent from prose and must branch
   * on the task explicitly. Putting it in the request keeps that need from leaking upward as a
   * second, provider-specific entry point.
   */
  task: AiTask;
  /** Instructions that frame the task. Never contains customer data. */
  system: string;
  /** The conversation excerpt or text the task operates on. */
  user: string;
  maxTokens?: number;
  /** `translate` only: the target language, as the operator named it. */
  targetLanguage?: string;
}

export interface AiProvider {
  /** Stable id recorded on every stored insight, so a result can always be attributed. */
  readonly id: string;
  /** Model identifier, when the provider has one. */
  readonly model: string | null;
  /**
   * Whether this provider can serve a request right now — configuration present, credentials set.
   * Checked before use so a misconfigured provider degrades to the fallback instead of throwing.
   */
  isAvailable(): boolean;
  complete(request: AiCompletionRequest): Promise<string>;
}

/** DI token for the ordered provider list (most preferred first). */
export const AI_PROVIDERS = Symbol('AI_PROVIDERS');
