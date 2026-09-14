import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { AiInsight } from '../entities/ai-insight.entity';
import { AnthropicAiProvider } from './anthropic.provider';
import { HeuristicAiProvider } from './heuristic.provider';
import type { AiProvider, AiTask } from './ai-provider.interface';

/** One turn of the excerpt handed to a provider. */
export interface TranscriptTurn {
  direction: 'incoming' | 'outgoing';
  body: string;
  type?: string;
}

/** The copilot panel's payload. */
export interface AiAnalysis {
  summary: string;
  intent: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  language: string;
  keyPoints: string[];
  extracted: Record<string, string>;
  suggestedReply: string;
  nextBestAction: string;
  provider: string;
  model: string | null;
  /** True when this came from cache rather than a fresh call. */
  cached: boolean;
  generatedAt: string;
}

const HANDOFF_SYSTEM = [
  'A support agent is taking over this WhatsApp conversation from a colleague, mid-thread.',
  'Brief them so the customer never notices the change of hands.',
  'Reply with a single JSON object and nothing else — no prose, no markdown fence.',
  'Use exactly these keys:',
  '  situation (string, 2-3 sentences: who the customer is and what they actually want)',
  '  promised (array of short strings: anything OUR side has already committed to or stated as fact —',
  '    prices, dates, refunds, callbacks. Empty if nothing was promised. Never invent a commitment.)',
  '  tone (string, one short phrase describing how the previous agent has been writing, e.g.',
  '    "warm and apologetic", "brisk and factual", so the handover reads consistently)',
  '  openQuestions (array of short strings: what the customer asked that has NOT been answered yet)',
  '  watchOut (string: the one thing likely to go wrong if handled carelessly. Empty if nothing.)',
  '  nextMessage (string: a reply the incoming agent could send now, in the customer’s language,',
  '    that continues the thread naturally rather than restarting it. Never re-introduce yourself',
  '    or ask the customer to repeat something already in the transcript.)',
  'Base everything on the transcript only. If something is not there, leave the field empty.',
].join('\n');

/** What an agent taking over a conversation is told before they type. */
export interface HandoffBrief {
  situation: string;
  /** Commitments our side has already made. Never invented — empty when nothing was promised. */
  promised: string[];
  tone: string;
  openQuestions: string[];
  watchOut: string;
  nextMessage: string;
  provider: string;
  model: string | null;
}

const ANALYSIS_SYSTEM = [
  'You are an assistant helping a business support agent triage a WhatsApp conversation.',
  'Reply with a single JSON object and nothing else — no prose, no markdown fence.',
  'Use exactly these keys:',
  '  summary (string, 2-3 sentences, factual, no speculation)',
  '  intent (string, snake_case, e.g. pricing, order_status, complaint, support, booking, payment)',
  '  sentiment (string: positive | neutral | negative)',
  '  language (string, the language the customer writes in, in English, e.g. "Spanish")',
  '  keyPoints (array of short strings — concrete facts worth remembering)',
  '  extracted (object of string values — customer details such as orderNumber, email, amount, address)',
  '  suggestedReply (string — a reply the agent could send as-is, in the customer’s language)',
  '  nextBestAction (string — one concrete next step for the agent)',
  'If a field cannot be determined from the conversation, use an empty string, array or object.',
  'Never invent facts the conversation does not contain.',
].join('\n');

/**
 * The AI copilot.
 *
 * Three rules shape everything here:
 *
 *  1. **No auto-send.** Nothing in this service can dispatch a WhatsApp message. It returns text;
 *     a human puts it in the composer and presses send. There is no code path from a model
 *     response to an engine.
 *  2. **Failure is contained.** Every public method either returns a usable result or throws a
 *     clean HTTP error the panel renders as an error state. A provider timeout, a malformed
 *     response or a missing key degrades to the offline provider — the inbox never breaks because
 *     the model did.
 *  3. **Attribution is recorded.** Every stored insight carries the provider and model that
 *     produced it, so "the AI said" is always answerable.
 */
@Injectable()
export class AiService {
  private readonly logger = createLogger('AiService');

  constructor(
    @InjectRepository(AiInsight, 'data') private readonly insights: Repository<AiInsight>,
    private readonly anthropic: AnthropicAiProvider,
    private readonly heuristic: HeuristicAiProvider,
  ) {}

  /** Providers in preference order. The heuristic is last and always available, so this is never empty. */
  private get providers(): AiProvider[] {
    return [this.anthropic, this.heuristic];
  }

  /** What the UI shows in the copilot's footer, so the operator knows what is answering. */
  status(): { provider: string; model: string | null; degraded: boolean } {
    const active = this.providers.find(p => p.isAvailable()) ?? this.heuristic;
    return { provider: active.id, model: active.model, degraded: active.id === this.heuristic.id };
  }

  /**
   * Analyze a conversation.
   *
   * Returns the cached insight when the conversation has not moved since it was produced —
   * `messageCountAtAnalysis` is the oracle, so a cache hit is a statement about the data, not a
   * timer. `force` skips the cache for the panel's explicit refresh button.
   */
  async analyze(conversationId: string, turns: TranscriptTurn[], force = false): Promise<AiAnalysis> {
    if (!force) {
      const cached = await this.insights.findOne({
        where: { conversationId },
        order: { createdAt: 'DESC' },
      });
      if (cached && cached.messageCountAtAnalysis === turns.length) {
        return toAnalysis(cached, true);
      }
    }

    const transcript = renderTranscript(turns);
    if (!transcript.trim()) {
      throw new ServiceUnavailableException('There are no messages in this conversation to analyze yet');
    }

    const { text, provider } = await this.run('analyze', ANALYSIS_SYSTEM, transcript, 2048);
    const parsed = parseAnalysisJson(text);

    const row = this.insights.create({
      conversationId,
      summary: parsed.summary,
      intent: parsed.intent,
      sentiment: parsed.sentiment,
      language: parsed.language,
      keyPoints: parsed.keyPoints,
      extracted: parsed.extracted,
      suggestedReply: parsed.suggestedReply,
      nextBestAction: parsed.nextBestAction,
      provider: provider.id,
      model: provider.model,
      messageCountAtAnalysis: turns.length,
    });

    let saved = row;
    try {
      saved = await this.insights.save(row);
      // Keep only the most recent few analyses per conversation — the history has no consumer and
      // an unbounded cache table is a slow leak on a busy inbox.
      await this.pruneInsights(conversationId);
    } catch (error) {
      // A cache write failure must not cost the operator their answer.
      this.logger.warn('Failed to store AI insight', { conversationId, error: String(error) });
    }
    return toAnalysis(saved, false);
  }

  /**
   * Brief an agent taking a conversation over from a colleague.
   *
   * Distinct from `analyze`, which describes a conversation to someone already in it. A handover
   * needs different things: what our side has already COMMITTED to (so the new agent does not
   * contradict it), the tone the previous agent used (so the customer does not feel handed off),
   * and what is still unanswered. It is deliberately not cached — the point of a briefing is that
   * it reflects the conversation at the moment of handover.
   */
  async handoffBrief(turns: TranscriptTurn[]): Promise<HandoffBrief> {
    const transcript = renderTranscript(turns);
    if (!transcript.trim()) {
      throw new ServiceUnavailableException('There is nothing in this conversation to brief on yet');
    }
    const { text, provider } = await this.run('handoff', HANDOFF_SYSTEM, transcript, 2048);
    return { ...parseHandoffJson(text), provider: provider.id, model: provider.model };
  }

  /** A reply draft for the composer. Returned as text — never sent. */
  async suggestReply(turns: TranscriptTurn[], instruction?: string): Promise<{ text: string; provider: string }> {
    const transcript = renderTranscript(turns);
    if (!transcript.trim()) {
      throw new ServiceUnavailableException('There are no messages to reply to yet');
    }
    const system = [
      'You are drafting a reply for a business support agent on WhatsApp.',
      'Write only the message body — no greeting boilerplate the agent did not ask for, no quotes, no explanation.',
      "Match the customer's language and keep it warm, concise and specific.",
      instruction ? `Additional instruction from the agent: ${instruction}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const { text, provider } = await this.run('suggest_reply', system, transcript, 1024);
    return { text: text.trim(), provider: provider.id };
  }

  /** Rewrite the agent's own draft. Operates on the draft alone — no customer data leaves with it. */
  rewrite(draft: string): Promise<{ text: string; provider: string }> {
    return this.transform(
      'rewrite',
      'Rewrite the message below so it reads professionally and warmly. Keep the meaning and the language identical. Reply with the rewritten message only.',
      draft,
    );
  }

  shorten(draft: string): Promise<{ text: string; provider: string }> {
    return this.transform(
      'shorten',
      'Shorten the message below to its essentials without losing meaning or politeness. Keep the same language. Reply with the shortened message only.',
      draft,
    );
  }

  translate(draft: string, targetLanguage: string): Promise<{ text: string; provider: string }> {
    return this.transform(
      'translate',
      `Translate the message below into ${targetLanguage}. Preserve tone and meaning. Reply with the translation only.`,
      draft,
      targetLanguage,
    );
  }

  private async transform(
    task: AiTask,
    system: string,
    input: string,
    targetLanguage?: string,
  ): Promise<{ text: string; provider: string }> {
    if (!input.trim()) throw new ServiceUnavailableException('There is nothing to work on — write a draft first');
    const { text, provider } = await this.run(task, system, input, 1024, targetLanguage);
    return { text: text.trim(), provider: provider.id };
  }

  /**
   * Try each available provider in order and return the first success.
   *
   * A vendor failure falls through to the next provider rather than surfacing — which in practice
   * means the offline provider, so the panel degrades instead of erroring. Only when every provider
   * fails (which the heuristic makes rare, and does deliberately for translation) does this throw.
   */
  private async run(
    task: AiTask,
    system: string,
    user: string,
    maxTokens: number,
    targetLanguage?: string,
  ): Promise<{ text: string; provider: AiProvider }> {
    const errors: string[] = [];
    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      try {
        const text = await provider.complete({ task, system, user, maxTokens, targetLanguage });
        if (text.trim()) return { text, provider };
        errors.push(`${provider.id}: empty response`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider.id}: ${message}`);
        this.logger.warn('AI provider failed; trying the next one', { provider: provider.id, task, error: message });
      }
    }
    throw new ServiceUnavailableException(
      `The AI assistant is unavailable right now (${errors.join('; ') || 'no provider configured'})`,
    );
  }

  private async pruneInsights(conversationId: string): Promise<void> {
    const keep = 3;
    const rows = await this.insights.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      select: { id: true },
      skip: keep,
      take: 50,
    });
    if (rows.length) await this.insights.delete(rows.map(r => r.id));
  }
}

/** Render turns as a labelled transcript. Media turns become a marker so the model sees the gap. */
export function renderTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map(turn => {
      const speaker = turn.direction === 'incoming' ? 'Customer' : 'Agent';
      const body = turn.body?.trim();
      if (body) return `${speaker}: ${body}`;
      return turn.type && turn.type !== 'text' ? `${speaker}: [${turn.type}]` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse the analysis JSON defensively.
 *
 * A model may wrap JSON in a markdown fence or add a sentence around it despite instructions, so
 * the outermost object is extracted before parsing. Every field is then coerced to its declared
 * type — a malformed response degrades to a partial result rather than throwing an exception into
 * the inbox.
 */
export function parseAnalysisJson(raw: string): {
  summary: string;
  intent: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  language: string;
  keyPoints: string[];
  extracted: Record<string, string>;
  suggestedReply: string;
  nextBestAction: string;
} {
  const fallback = {
    summary: '',
    intent: 'unknown',
    sentiment: 'neutral' as const,
    language: 'English',
    keyPoints: [] as string[],
    extracted: {} as Record<string, string>,
    suggestedReply: '',
    nextBestAction: '',
  };

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { ...fallback, summary: raw.trim().slice(0, 1000) };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { ...fallback, summary: raw.trim().slice(0, 1000) };
  }

  const str = (key: string, max = 2000): string => {
    const value = parsed[key];
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  };
  const sentiment = str('sentiment').toLowerCase();

  return {
    summary: str('summary'),
    intent: str('intent', 60) || 'unknown',
    sentiment: sentiment === 'positive' || sentiment === 'negative' ? sentiment : 'neutral',
    language: str('language', 40) || 'English',
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints
          .filter((p): p is string => typeof p === 'string')
          .map(p => p.slice(0, 300))
          .slice(0, 12)
      : [],
    extracted: coerceStringMap(parsed.extracted),
    suggestedReply: str('suggestedReply'),
    nextBestAction: str('nextBestAction', 240),
  };
}

/**
 * Parse a handoff briefing, with the same defensive posture as the analysis parser: a malformed
 * response degrades to a partial briefing rather than throwing at an agent who is mid-handover.
 */
export function parseHandoffJson(raw: string): Omit<HandoffBrief, 'provider' | 'model'> {
  const empty = { situation: '', promised: [], tone: '', openQuestions: [], watchOut: '', nextMessage: '' };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { ...empty, situation: raw.trim().slice(0, 1000) };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { ...empty, situation: raw.trim().slice(0, 1000) };
  }

  const str = (key: string, max = 1200): string =>
    typeof parsed[key] === 'string' ? parsed[key].trim().slice(0, max) : '';
  const list = (key: string): string[] =>
    Array.isArray(parsed[key])
      ? (parsed[key] as unknown[])
          .filter((v): v is string => typeof v === 'string')
          .map(v => v.slice(0, 300))
          .slice(0, 10)
      : [];

  return {
    situation: str('situation'),
    promised: list('promised'),
    tone: str('tone', 120),
    openQuestions: list('openQuestions'),
    watchOut: str('watchOut', 400),
    nextMessage: str('nextMessage'),
  };
}

function coerceStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === '') continue;
    // Only primitives are coerced. An object here would stringify to "[object Object]", which is
    // not a customer detail — a model that nested a value has produced something this contract
    // cannot express, and dropping it is better than storing a placeholder.
    const text =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint'
          ? String(raw)
          : null;
    if (text === null || text === '') continue;
    out[key.slice(0, 40)] = text.slice(0, 500);
    if (Object.keys(out).length >= 20) break;
  }
  return out;
}

function toAnalysis(row: AiInsight, cached: boolean): AiAnalysis {
  return {
    summary: row.summary ?? '',
    intent: row.intent ?? 'unknown',
    sentiment: row.sentiment ?? 'neutral',
    language: row.language ?? 'English',
    keyPoints: row.keyPoints ?? [],
    extracted: row.extracted ?? {},
    suggestedReply: row.suggestedReply ?? '',
    nextBestAction: row.nextBestAction ?? '',
    provider: row.provider,
    model: row.model,
    cached,
    generatedAt: (row.createdAt ?? new Date()).toISOString(),
  };
}
