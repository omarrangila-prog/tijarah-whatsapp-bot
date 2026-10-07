/**
 * Which reasoner is answering clients, said in a sentence the office can act on.
 *
 * `GET /api/agent/status` reports every provider, whether it is configured, and how each last
 * fared. Read raw it is a list of ids; what matters is one thing — is the bot understanding
 * sentences, or has it fallen back to fixed phrasings — and, when not, which key to fix.
 */

/** One provider, as `/api/agent/status` reports it. */
export interface ReasoningProviderStatus {
  id: string;
  model: string | null;
  available: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** `mock` is the rule-based reasoner: always present, understands fixed phrasings only. */
export const FALLBACK_PROVIDER_ID = 'mock';

export interface ReasoningHealth {
  /** 'ok' — an AI is answering · 'degraded' — configured but failing · 'fallback' — none configured. */
  level: 'ok' | 'degraded' | 'fallback';
  headline: string;
  /** What to do about it, or null when nothing needs doing. */
  advice: string | null;
  /** The provider answering now, for the detail line. */
  activeId: string | null;
}

const PROVIDER_NAMES: Record<string, string> = {
  openAiCompatible: 'your AI provider',
  gemini: 'Gemini',
  anthropic: 'Claude',
  mock: 'the built-in rules',
};

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

/**
 * The first provider that would be asked, which is the order the runtime tries them in.
 *
 * Deliberately independent of whether the last call failed: a provider that is configured and
 * erroring is still the one being asked, and saying so is what points at the key to fix.
 */
export function summariseReasoning(providers: ReasoningProviderStatus[] | undefined): ReasoningHealth {
  const configured = (providers ?? []).filter(p => p.available && p.id !== FALLBACK_PROVIDER_ID);
  const active = configured[0] ?? null;

  if (!active) {
    return {
      level: 'fallback',
      headline: 'No AI is set up, so only fixed phrasings are understood',
      advice: 'Set AI_BASE_URL, AI_API_KEY and AI_MODEL (or GEMINI_API_KEY) in deploy/.env and redeploy.',
      activeId: (providers ?? []).length ? FALLBACK_PROVIDER_ID : null,
    };
  }

  // A provider whose last call failed and that has not succeeded since is the one to fix. The
  // comparison is on the timestamps rather than "has an error", because an error from an hour
  // ago followed by a success is history, not a fault.
  const failing = active.lastError !== null && !after(active.lastOkAt, active.lastErrorAt);
  if (failing) {
    return {
      level: 'degraded',
      headline: `${providerName(active.id)} is not answering, so only fixed phrasings are understood`,
      advice: active.lastError,
      activeId: active.id,
    };
  }

  return {
    level: 'ok',
    headline: `${providerName(active.id)} is answering${active.model ? ` (${active.model})` : ''}`,
    advice: null,
    activeId: active.id,
  };
}

/** Whether `a` is later than `b`, with a missing value counting as never. */
function after(a: string | null, b: string | null): boolean {
  if (!a) return false;
  if (!b) return true;
  return new Date(a).getTime() > new Date(b).getTime();
}
