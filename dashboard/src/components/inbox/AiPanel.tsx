import { useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Check,
  CircleDot,
  Copy,
  Languages,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type { AiAnalysis, AiStatus } from '../../services/commandCenter';
import { ErrorState, Skeleton } from '../cc/Primitives';
import { absoluteTime } from '../../utils/ccFormat';

interface AiPanelProps {
  analysis: AiAnalysis | undefined;
  status: AiStatus | undefined;
  loading: boolean;
  error: unknown;
  onAnalyze: (force: boolean) => void;
  /** Puts text in the composer for the agent to review. Never sends. */
  onUseReply: (text: string) => void;
  onSuggestReply: () => void;
  suggesting: boolean;
  /** Merge an extracted detail into the customer profile's custom fields. */
  onSaveDetail?: (key: string, value: string) => void;
}

const SENTIMENT_TONE: Record<string, string> = {
  positive: 'resolved',
  neutral: 'neutral',
  negative: 'urgent',
};

/**
 * The AI copilot panel.
 *
 * Every output here is a draft: the suggested reply goes into the composer, never onto WhatsApp,
 * and the button says so. When only the offline provider is available the panel says that too —
 * presenting rule-based output as model output would be a lie about where the answer came from.
 */
export function AiPanel({
  analysis,
  status,
  loading,
  error,
  onAnalyze,
  onUseReply,
  onSuggestReply,
  suggesting,
  onSaveDetail,
}: AiPanelProps) {
  const [copied, setCopied] = useState(false);

  const copyReply = async () => {
    if (!analysis?.suggestedReply) return;
    try {
      await navigator.clipboard.writeText(analysis.suggestedReply);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions). The reply is on screen and
      // selectable, so a failed copy is a non-event — not worth an error toast.
    }
  };

  if (loading) {
    return (
      <div className="inbox-ai">
        <div className="cc-stack" style={{ gap: '1rem' }}>
          <Skeleton height={14} width="40%" />
          <Skeleton height={54} radius="var(--cc-radius)" />
          <Skeleton height={14} width="55%" />
          <Skeleton height={80} radius="var(--cc-radius)" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="inbox-ai">
        <ErrorState error={error} onRetry={() => onAnalyze(true)} />
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="inbox-ai inbox-ai-intro">
        <div className="inbox-ai-icon">
          <Sparkles size={20} />
        </div>
        <h3>AI copilot</h3>
        <p>
          Summarise the conversation, read intent and sentiment, pull out order numbers and emails, and draft a reply
          you approve before anything is sent.
        </p>
        <button type="button" className="cc-btn cc-btn-primary" onClick={() => onAnalyze(false)}>
          <Brain size={14} /> Analyze conversation
        </button>
        {status?.degraded && (
          <p className="inbox-ai-degraded">
            <AlertTriangle size={12} /> No AI provider configured — results come from the built-in offline analyser.
          </p>
        )}
      </div>
    );
  }

  const extracted = Object.entries(analysis.extracted ?? {});

  return (
    <div className="inbox-ai">
      <div className="inbox-ai-head">
        <span className="inbox-ai-provider">
          <Sparkles size={12} />
          {analysis.provider === 'heuristic' ? 'Offline analyser' : `${analysis.provider}${analysis.model ? ` · ${analysis.model}` : ''}`}
        </span>
        <button
          type="button"
          className="cc-btn cc-btn-ghost cc-btn-sm"
          onClick={() => onAnalyze(true)}
          title="Re-run the analysis"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {analysis.cached && (
        <p className="inbox-ai-cached">Cached from {absoluteTime(analysis.generatedAt)} — the conversation has not changed since.</p>
      )}

      <section className="inbox-ai-section">
        <p className="cc-label">Summary</p>
        <p className="inbox-ai-summary">{analysis.summary || 'No summary available for this conversation.'}</p>
      </section>

      <section className="inbox-ai-section inbox-ai-signals">
        <div className="inbox-ai-signal">
          <span className="cc-label">Intent</span>
          <span className="cc-chip cc-chip-neutral">{analysis.intent.replace(/_/g, ' ')}</span>
        </div>
        <div className="inbox-ai-signal">
          <span className="cc-label">Sentiment</span>
          <span className={`cc-chip cc-chip-${SENTIMENT_TONE[analysis.sentiment] ?? 'neutral'}`}>
            {analysis.sentiment}
          </span>
        </div>
        <div className="inbox-ai-signal">
          <span className="cc-label">Language</span>
          <span className="cc-chip cc-chip-neutral">{analysis.language}</span>
        </div>
      </section>

      {analysis.keyPoints.length > 0 && (
        <section className="inbox-ai-section">
          <p className="cc-label">Important information</p>
          <ul className="inbox-ai-points">
            {analysis.keyPoints.map((point, index) => (
              <li key={index}>
                <CircleDot size={11} />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {extracted.length > 0 && (
        <section className="inbox-ai-section">
          <p className="cc-label">Extracted details</p>
          <dl className="inbox-ai-extracted">
            {extracted.map(([key, value]) => (
              <div key={key} className="inbox-ai-extracted-row">
                <dt>{key}</dt>
                <dd className="cc-truncate" title={value}>
                  {value}
                </dd>
                {onSaveDetail && (
                  <button
                    type="button"
                    className="cc-btn cc-btn-ghost cc-btn-sm"
                    onClick={() => onSaveDetail(key, value)}
                    title="Save to the customer profile"
                  >
                    Save
                  </button>
                )}
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="inbox-ai-section">
        <div className="cc-row-between" style={{ marginBottom: '0.4rem' }}>
          <p className="cc-label" style={{ margin: 0 }}>
            Suggested response
          </p>
          <button type="button" className="cc-btn cc-btn-ghost cc-btn-sm" onClick={onSuggestReply} disabled={suggesting}>
            {suggesting ? <Loader2 size={12} className="cc-spin" /> : <Languages size={12} />} Redraft
          </button>
        </div>
        <div className="inbox-ai-reply">{analysis.suggestedReply || 'No draft available.'}</div>
        <div className="inbox-ai-reply-actions">
          <button
            type="button"
            className="cc-btn cc-btn-primary cc-btn-sm"
            onClick={() => onUseReply(analysis.suggestedReply)}
            disabled={!analysis.suggestedReply}
          >
            Use in composer
          </button>
          <button type="button" className="cc-btn cc-btn-sm" onClick={copyReply} disabled={!analysis.suggestedReply}>
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="inbox-ai-disclaimer">Nothing is sent until you review it and press send.</p>
      </section>

      {analysis.nextBestAction && (
        <section className="inbox-ai-section inbox-ai-next">
          <Lightbulb size={14} />
          <div>
            <p className="cc-label" style={{ marginBottom: '0.15rem' }}>
              Next best action
            </p>
            <p>{analysis.nextBestAction}</p>
          </div>
        </section>
      )}
    </div>
  );
}

export default AiPanel;
