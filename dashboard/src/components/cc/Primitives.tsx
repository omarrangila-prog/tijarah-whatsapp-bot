import type { CSSProperties, ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { ConversationPriority, ConversationStatus, Tag } from '../../services/commandCenter';
// Pure helpers live in utils/ so this file exports components only (and so they can be unit-tested).
import { avatarColor, initials } from '../../utils/avatar';

// Shared building blocks for every command-center surface. They are presentational only — no data
// fetching, no side effects — so a page can compose them without inheriting behaviour it did not ask
// for. Styling lives in styles/command-center.css.

interface AvatarProps {
  name: string | null | undefined;
  /** Stable identity for the colour. Falls back to the name when absent. */
  seed?: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Avatar({ name, seed, src, size = 'md', className = '' }: AvatarProps) {
  const key = seed || name || '?';
  const sizeClass = size === 'sm' ? 'cc-avatar-sm' : size === 'lg' ? 'cc-avatar-lg' : '';
  if (src) {
    return <img className={`cc-avatar ${sizeClass} ${className}`} src={src} alt={name ?? ''} loading="lazy" />;
  }
  return (
    <span
      className={`cc-avatar ${sizeClass} ${className}`}
      style={{ background: avatarColor(key) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: 'Open',
  waiting: 'Waiting',
  resolved: 'Resolved',
};

export function StatusChip({ status }: { status: ConversationStatus }) {
  return <span className={`cc-chip cc-chip-${status}`}>{STATUS_LABELS[status]}</span>;
}

const PRIORITY_LABELS: Record<ConversationPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/**
 * Priority chip.
 *
 * `normal` renders nothing: it is the default on every conversation, so a chip for it would be
 * noise on every row and would make the ones that matter harder to spot.
 */
export function PriorityChip({ priority }: { priority: ConversationPriority }) {
  if (priority === 'normal') return null;
  const tone = priority === 'urgent' ? 'urgent' : priority === 'high' ? 'high' : 'neutral';
  return <span className={`cc-chip cc-chip-${tone}`}>{PRIORITY_LABELS[priority]}</span>;
}

export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  return (
    <span className="cc-chip cc-chip-tag" style={{ '--tag': tag.color } as CSSProperties}>
      {tag.name}
      {onRemove && (
        <button type="button" className="cc-chip-x" onClick={onRemove} aria-label={`Remove tag ${tag.name}`}>
          ×
        </button>
      )}
    </span>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="cc-empty">
      {icon && <div className="cc-empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/**
 * Error state.
 *
 * Always shows the real message rather than a generic apology — an operator debugging a 403 needs
 * to know it was a 403 — and offers a retry whenever the caller can supply one.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error ?? 'Something went wrong');
  return (
    <div className="cc-error">
      <AlertCircle size={16} />
      <div style={{ flex: 1 }}>
        <div>{message}</div>
        {onRetry && (
          <button type="button" className="cc-btn cc-btn-sm" style={{ marginTop: '0.6rem' }} onClick={onRetry}>
            <RefreshCw size={13} /> Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** A shimmering placeholder block. `lines` stacks several at decreasing widths. */
export function Skeleton({
  width = '100%',
  height = 12,
  radius,
  className = '',
}: {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}) {
  return (
    <div
      className={`cc-skeleton ${className}`}
      style={{ width, height, ...(radius ? { borderRadius: radius } : {}) }}
      aria-hidden="true"
    />
  );
}

export function SkeletonList({ rows = 6, height = 56 }: { rows?: number; height?: number }) {
  return (
    <div className="cc-stack" role="status" aria-label="Loading" style={{ padding: '0.75rem' }}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={height} radius="var(--cc-radius)" />
      ))}
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
  tone?: 'default' | 'open' | 'waiting' | 'resolved' | 'urgent';
}

/**
 * A single headline number.
 *
 * `value` accepts a node so a caller can render an em dash for a metric with no data, rather than a
 * zero that would read as a real measurement.
 */
export function KpiCard({ label, value, hint, icon, tone = 'default' }: KpiCardProps) {
  return (
    <div className={`cc-kpi cc-kpi-${tone}`}>
      <div className="cc-kpi-head">
        <span className="cc-kpi-label">{label}</span>
        {icon && <span className="cc-kpi-icon">{icon}</span>}
      </div>
      <div className="cc-kpi-value cc-num">{value}</div>
      {hint && <div className="cc-kpi-hint">{hint}</div>}
    </div>
  );
}

/** Health dot for a WhatsApp number, mapped from the session status vocabulary. */
export function HealthDot({ status }: { status: string }) {
  const tone =
    status === 'ready'
      ? 'ready'
      : status === 'failed' || status === 'disconnected'
        ? 'down'
        : status === 'created'
          ? ''
          : 'warn';
  return <span className={`cc-dot ${tone ? `cc-dot-${tone}` : ''}`} aria-hidden="true" />;
}
