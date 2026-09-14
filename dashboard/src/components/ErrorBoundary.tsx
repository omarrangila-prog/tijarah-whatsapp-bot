import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import i18n from '../i18n';
import { clearChunkReloadGuard } from '../utils/chunkReload';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
  }

  handleReload = () => {
    // Clear the one-shot chunk-reload guard FIRST. The commonest way to reach this screen is a
    // stale lazy chunk after a redeploy: the retry helper already spent its single reload, so
    // reloading without clearing the flag lands on this same screen again — which is what made the
    // error look permanent rather than recoverable.
    clearChunkReloadGuard(window.sessionStorage);
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '2rem',
            fontFamily: 'system-ui, sans-serif',
            color: 'var(--text-primary)',
          }}
        >
          <AlertCircle size={48} style={{ color: 'var(--error)', marginBottom: '1rem' }} />
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{i18n.t('errorBoundary.title')}</h1>
          <p style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', textAlign: 'center' }}>
            {i18n.t('errorBoundary.description')}
          </p>
          {/* The actual message, so the failure is diagnosable instead of merely apologised for. */}
          {this.state.error?.message && (
            <code
              style={{
                display: 'block',
                maxWidth: '46rem',
                marginBottom: '1.5rem',
                padding: '0.6rem 0.8rem',
                fontSize: '0.8125rem',
                lineHeight: 1.5,
                textAlign: 'center',
                color: 'var(--text-secondary)',
                background: 'var(--cc-surface-inset, rgba(127,127,127,0.08))',
                border: '1px solid var(--cc-border, rgba(127,127,127,0.2))',
                borderRadius: '8px',
                overflowWrap: 'anywhere',
              }}
            >
              {this.state.error.message}
            </code>
          )}
          <button
            onClick={this.handleReload}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              backgroundColor: 'var(--primary)',
              color: 'white',
              border: 'none',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontSize: '1rem',
            }}
          >
            <RefreshCw size={18} />
            {i18n.t('errorBoundary.reload')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
