import { AlertTriangle, ArrowRightLeft, Check, Loader2, MessageSquareQuote, X } from 'lucide-react';
import type { HandoffBrief } from '../../services/commandCenter';
import { ErrorState } from '../cc/Primitives';

interface HandoffBannerProps {
  brief: HandoffBrief | null;
  loading: boolean;
  error: unknown;
  fromAgentName: string | null;
  /** Puts the suggested opener in the composer. Never sends it. */
  onUseMessage: (text: string) => void;
  onDismiss: () => void;
  onRetry: () => void;
}

/**
 * The briefing an agent sees when a conversation has just been handed to them.
 *
 * Ordered by what you need before you can type: what is going on, what we have already committed to
 * (the thing you must not contradict), what is still unanswered, and only then a suggested opener.
 * `promised` is the load-bearing field — an incoming agent who contradicts a commitment their
 * colleague made does more damage than one who says nothing at all.
 */
export function HandoffBanner({
  brief,
  loading,
  error,
  fromAgentName,
  onUseMessage,
  onDismiss,
  onRetry,
}: HandoffBannerProps) {
  return (
    <aside className="inbox-handoff" role="status">
      <div className="inbox-handoff-head">
        <ArrowRightLeft size={14} />
        <strong>
          Handed to you{fromAgentName ? ` by ${fromAgentName}` : ''}
        </strong>
        <button type="button" className="cc-btn cc-btn-ghost cc-btn-sm" onClick={onDismiss} aria-label="Dismiss briefing">
          <X size={13} />
        </button>
      </div>

      {loading ? (
        <p className="inbox-handoff-loading">
          <Loader2 size={13} className="cc-spin" /> Reading the conversation…
        </p>
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : brief ? (
        <div className="inbox-handoff-body">
          {brief.situation && <p className="inbox-handoff-situation">{brief.situation}</p>}

          {brief.promised.length > 0 && (
            <div className="inbox-handoff-block is-promised">
              <span className="cc-label">Already promised — do not contradict</span>
              <ul>
                {brief.promised.map((item, index) => (
                  <li key={index}>
                    <Check size={11} /> {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {brief.openQuestions.length > 0 && (
            <div className="inbox-handoff-block">
              <span className="cc-label">Still unanswered</span>
              <ul>
                {brief.openQuestions.map((item, index) => (
                  <li key={index}>
                    <MessageSquareQuote size={11} /> {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="inbox-handoff-meta">
            {brief.tone && (
              <span>
                <span className="cc-label">Tone</span> {brief.tone}
              </span>
            )}
          </div>

          {brief.watchOut && (
            <p className="inbox-handoff-watch">
              <AlertTriangle size={12} /> {brief.watchOut}
            </p>
          )}

          {brief.nextMessage && (
            <div className="inbox-handoff-next">
              <span className="cc-label">Suggested opener</span>
              <p>{brief.nextMessage}</p>
              <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={() => onUseMessage(brief.nextMessage)}>
                Use in composer
              </button>
              <span className="inbox-handoff-provider">
                {brief.provider === 'heuristic' ? 'offline analyser' : brief.provider}
              </span>
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}

export default HandoffBanner;
