import { useId } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The product mark: a conversation bubble holding three ascending bars.
 *
 * Inline SVG rather than an <img>: it stays crisp at every size and needs no network round trip on
 * first paint. The gradient id comes from `useId` because an SVG gradient id is document-global —
 * two logos sharing one would leave the second rendering unfilled — and a module-level counter
 * would be a side effect during render, which breaks under StrictMode's double invocation.
 */
export function Logo({ size = 32, className = '' }: { size?: number; className?: string }) {
  const { t } = useTranslation();
  const gradientId = `brand-g-${useId()}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label={t('common.appName')}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#25d366" />
          <stop offset="55%" stopColor="#12b3a8" />
          <stop offset="100%" stopColor="#5b5bd6" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill={`url(#${gradientId})`} />
      <path
        d="M14.5 12h19a5.5 5.5 0 0 1 5.5 5.5v11a5.5 5.5 0 0 1-5.5 5.5H24.9l-7.4 5.6a1 1 0 0 1-1.6-.8V34h-1.4A5.5 5.5 0 0 1 9 28.5v-11A5.5 5.5 0 0 1 14.5 12Z"
        fill="#fff"
      />
      <g fill={`url(#${gradientId})`}>
        <rect x="15.4" y="24.4" width="4.6" height="5.2" rx="1.6" />
        <rect x="21.7" y="20.4" width="4.6" height="9.2" rx="1.6" />
        <rect x="28" y="16.4" width="4.6" height="13.2" rx="1.6" />
      </g>
    </svg>
  );
}

export default Logo;
