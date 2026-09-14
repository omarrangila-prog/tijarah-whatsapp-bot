import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Zap } from 'lucide-react';
import type { QuickReply } from '../../services/commandCenter';

interface QuickReplyPickerProps {
  replies: QuickReply[];
  /** The text typed after `/`. An empty string means the bare slash — show everything. */
  query: string;
  loading?: boolean;
  onPick: (reply: QuickReply) => void;
  onClose: () => void;
}

/**
 * The `/` quick-reply selector.
 *
 * Keyboard-first, because that is the whole point of a shortcut: arrows move, Enter inserts, Escape
 * closes, and the mouse is optional. Filtering matches the shortcut, the title and the body, so an
 * agent who remembers the wording but not the shortcut still finds it.
 */
export function QuickReplyPicker({ replies, query, loading, onPick, onClose }: QuickReplyPickerProps) {
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? replies.filter(
          reply =>
            reply.shortcut.includes(needle) ||
            reply.title.toLowerCase().includes(needle) ||
            reply.body.toLowerCase().includes(needle),
        )
      : replies;
    // Shortcut prefix matches first — typing "/pr" should reach /price before a reply that merely
    // mentions the word somewhere in its body.
    return [...pool].sort((a, b) => {
      const aPrefix = a.shortcut.startsWith(needle) ? 0 : 1;
      const bPrefix = b.shortcut.startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix || b.useCount - a.useCount;
    });
  }, [replies, query]);

  // Reset the cursor whenever the candidate set changes, so Enter never fires the reply that
  // happened to be highlighted for a previous query.
  useEffect(() => setHighlight(0), [query, replies.length]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight(current => (matches.length ? (current + 1) % matches.length : 0));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight(current => (matches.length ? (current - 1 + matches.length) % matches.length : 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const reply = matches[highlight];
        if (reply) {
          event.preventDefault();
          onPick(reply);
        }
      }
    };
    // Capture phase so the composer's own Enter-to-send handler does not fire first and send the
    // half-typed `/pri` as a message.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [matches, highlight, onPick, onClose]);

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  return (
    <div className="inbox-qr" role="dialog" aria-label="Quick replies">
      <div className="inbox-qr-head">
        <Zap size={13} />
        <span>Quick replies</span>
        <kbd>↑↓</kbd>
        <kbd>Enter</kbd>
        <kbd>Esc</kbd>
      </div>
      {loading ? (
        <div className="inbox-qr-empty">
          <Loader2 size={14} className="cc-spin" /> Loading…
        </div>
      ) : matches.length === 0 ? (
        <div className="inbox-qr-empty">
          No reply matches <strong>/{query}</strong>. Create one on the Quick Replies page.
        </div>
      ) : (
        <ul className="inbox-qr-list" ref={listRef}>
          {matches.slice(0, 8).map((reply, index) => (
            <li key={reply.id}>
              <button
                type="button"
                className={`inbox-qr-item ${index === highlight ? 'is-active' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => onPick(reply)}
              >
                <span className="inbox-qr-shortcut">/{reply.shortcut}</span>
                <span className="inbox-qr-title cc-truncate">{reply.title}</span>
                <span className="inbox-qr-body cc-truncate">{reply.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default QuickReplyPicker;
