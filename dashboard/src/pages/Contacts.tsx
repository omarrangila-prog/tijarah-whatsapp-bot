import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Search, ShieldCheck, ShieldOff, ShieldQuestion, Users, X } from 'lucide-react';
import { useCustomerMutations, useCustomersQuery, useCustomerQuery } from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { Avatar, EmptyState, ErrorState, Skeleton } from '../components/cc/Primitives';
import { absoluteTime, dateOnly, formatCount, formatWaId } from '../utils/ccFormat';
import type { ConsentStatus } from '../services/commandCenter';
import './Contacts.css';

const CONSENT_META: Record<ConsentStatus, { label: string; icon: typeof ShieldCheck; tone: string }> = {
  opted_in: { label: 'Opted in', icon: ShieldCheck, tone: 'resolved' },
  opted_out: { label: 'Opted out', icon: ShieldOff, tone: 'urgent' },
  unknown: { label: 'Unknown', icon: ShieldQuestion, tone: 'neutral' },
};

const PAGE_SIZE = 40;

/**
 * Customer 360.
 *
 * A searchable book on the left, one customer's full picture on the right. Everything derived —
 * message count, which numbers they have used, when they first appeared — is computed by the server
 * from the message history rather than stored, so it cannot drift from the truth.
 */
export function Contacts() {
  useDocumentTitle('Contacts');
  const { success, error: showError } = useToast();

  const [search, setSearch] = useState('');
  const [consent, setConsent] = useState<ConsentStatus | ''>('');
  const [customerType, setCustomerType] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedWaId, setSelectedWaId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [consentSource, setConsentSource] = useState('');

  const listQuery = useCustomersQuery({
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(consent ? { consent } : {}),
    ...(customerType ? { customerType } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const detailQuery = useCustomerQuery(selectedWaId);
  const sessionsQuery = useSessionsQuery();
  const mutations = useCustomerMutations();

  const customers = useMemo(() => listQuery.data?.customers ?? [], [listQuery.data]);
  const total = listQuery.data?.total ?? 0;
  const customer = detailQuery.data;
  const sessionsById = useMemo(
    () => new Map((sessionsQuery.data ?? []).map(session => [session.id, session])),
    [sessionsQuery.data],
  );

  const startEdit = () => {
    setDraft({
      displayName: customer?.displayName ?? '',
      company: customer?.company ?? '',
      email: customer?.email ?? '',
      customerType: customer?.customerType ?? '',
      city: customer?.city ?? '',
      source: customer?.source ?? '',
    });
    setEditing(true);
  };

  const save = () => {
    if (!selectedWaId) return;
    mutations.update.mutate(
      { waId: selectedWaId, ...draft },
      {
        onSuccess: () => {
          success('Customer updated');
          setEditing(false);
        },
        onError: error => showError(error instanceof Error ? error.message : 'Could not save the customer'),
      },
    );
  };

  return (
    <div className={`cc-page contacts ${selectedWaId ? 'has-selection' : ''}`}>
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Contacts</h1>
          <p className="cc-page-sub">
            Everyone who has messaged one of your numbers, with the business context your team adds.
          </p>
        </div>
      </header>

      <div className="contacts-layout">
        <section className="cc-card contacts-list">
          <div className="contacts-filters">
            <div className="cc-search">
              <Search size={15} />
              <input
                className="cc-search-input"
                type="search"
                placeholder="Name, company, email or number…"
                value={search}
                onChange={event => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
                aria-label="Search contacts"
              />
              {search && (
                <button type="button" className="cc-search-clear" onClick={() => setSearch('')} aria-label="Clear">
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="cc-row" style={{ gap: '0.35rem' }}>
              <select
                className="cc-mini-select"
                value={consent}
                onChange={event => {
                  setConsent(event.target.value as ConsentStatus | '');
                  setOffset(0);
                }}
                aria-label="Filter by consent"
              >
                <option value="">Any consent</option>
                <option value="opted_in">Opted in</option>
                <option value="opted_out">Opted out</option>
                <option value="unknown">Unknown</option>
              </select>
              <input
                className="cc-mini-select"
                placeholder="Customer type"
                value={customerType}
                onChange={event => {
                  setCustomerType(event.target.value);
                  setOffset(0);
                }}
                aria-label="Filter by customer type"
              />
            </div>
            <p className="contacts-count cc-num">
              {formatCount(total)} contact{total === 1 ? '' : 's'}
            </p>
          </div>

          <div className="contacts-scroll">
            {listQuery.isLoading ? (
              <div style={{ padding: '0.75rem' }}>
                <Skeleton height={54} />
              </div>
            ) : listQuery.error ? (
              <div style={{ padding: '1rem' }}>
                <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
              </div>
            ) : customers.length === 0 ? (
              <EmptyState
                icon={<Users size={20} />}
                title={search ? 'No matching contacts' : 'No contacts yet'}
                description={
                  search
                    ? 'Try a different name, company or number.'
                    : 'Contacts are created automatically when someone messages one of your numbers.'
                }
              />
            ) : (
              <ul className="contacts-rows">
                {customers.map(row => {
                  const status = row.consent?.status ?? 'unknown';
                  const Icon = CONSENT_META[status].icon;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        className={`contacts-row ${selectedWaId === row.waId ? 'is-selected' : ''}`}
                        onClick={() => {
                          setSelectedWaId(row.waId);
                          setEditing(false);
                        }}
                      >
                        <Avatar name={row.displayName} seed={row.waId} />
                        <span className="contacts-row-main">
                          <span className="contacts-row-name cc-truncate">
                            {row.displayName || formatWaId(row.waId)}
                          </span>
                          {/* A subtitle only when it says something the name does not: a contact
                              with no company was otherwise repeating its own name underneath itself. */}
                          {row.company ? (
                            <span className="contacts-row-sub cc-truncate">{row.company}</span>
                          ) : row.displayName ? (
                            <span className="contacts-row-sub cc-truncate">{formatWaId(row.waId)}</span>
                          ) : null}
                        </span>
                        <span className={`contacts-consent is-${CONSENT_META[status].tone}`} title={CONSENT_META[status].label}>
                          <Icon size={12} />
                        </span>
                        <span className="contacts-row-count cc-num">{formatCount(row.messageCount)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {total > PAGE_SIZE && (
            <div className="contacts-pager">
              <button
                type="button"
                className="cc-btn cc-btn-sm"
                disabled={offset === 0}
                onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}
              >
                Previous
              </button>
              <span className="cc-num">
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <button
                type="button"
                className="cc-btn cc-btn-sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(current => current + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </section>

        <section className="cc-card contacts-detail">
          {!selectedWaId ? (
            <EmptyState
              icon={<Users size={20} />}
              title="Select a contact"
              description="Pick someone from the list to see their profile, consent state and conversation history."
            />
          ) : detailQuery.isLoading ? (
            <div className="cc-card-body cc-stack">
              <Skeleton height={72} />
              <Skeleton height={140} />
            </div>
          ) : detailQuery.error ? (
            <div className="cc-card-body">
              <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
            </div>
          ) : customer ? (
            <>
              <header className="contacts-detail-head">
                <button
                  type="button"
                  className="contacts-back cc-btn cc-btn-ghost cc-btn-icon"
                  onClick={() => setSelectedWaId(null)}
                  aria-label="Back to contacts"
                >
                  <ArrowLeft size={17} />
                </button>
                <Avatar name={customer.displayName} seed={customer.waId} size="lg" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h2 className="contacts-detail-name cc-truncate">
                    {customer.displayName || formatWaId(customer.waId)}
                  </h2>
                  <p className="contacts-detail-sub">{formatWaId(customer.waId)}</p>
                </div>
                {!editing ? (
                  <button type="button" className="cc-btn cc-btn-sm" onClick={startEdit}>
                    Edit
                  </button>
                ) : (
                  <span className="cc-row" style={{ gap: '0.3rem' }}>
                    <button type="button" className="cc-btn cc-btn-sm" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                    <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={save} disabled={mutations.update.isPending}>
                      Save
                    </button>
                  </span>
                )}
              </header>

              <div className="cc-card-body">
                {editing ? (
                  <div className="contacts-form">
                    {(
                      [
                        ['displayName', 'Name'],
                        ['company', 'Company'],
                        ['email', 'Email'],
                        ['customerType', 'Customer type'],
                        ['city', 'City'],
                        ['source', 'Source'],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field} className="cc-field">
                        <span>{label}</span>
                        <input
                          className="cc-input"
                          value={draft[field] ?? ''}
                          onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))}
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <dl className="contacts-facts">
                    <div>
                      <dt>Company</dt>
                      <dd>{customer.company || '—'}</dd>
                    </div>
                    <div>
                      <dt>Email</dt>
                      <dd className="cc-truncate">{customer.email || '—'}</dd>
                    </div>
                    <div>
                      <dt>Type</dt>
                      <dd>{customer.customerType || '—'}</dd>
                    </div>
                    <div>
                      <dt>City</dt>
                      <dd>{customer.city || '—'}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{customer.source || '—'}</dd>
                    </div>
                    <div>
                      <dt>Messages</dt>
                      <dd className="cc-num">{formatCount(customer.messageCount)}</dd>
                    </div>
                    <div>
                      <dt>First seen</dt>
                      <dd>{dateOnly(customer.firstInteractionAt)}</dd>
                    </div>
                    <div>
                      <dt>Last seen</dt>
                      <dd>{absoluteTime(customer.lastInteractionAt)}</dd>
                    </div>
                    {Object.entries(customer.customFields ?? {}).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd className="cc-truncate">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                <section className="contacts-block">
                  <p className="cc-label">Numbers used</p>
                  {customer.sessionIds.length === 0 ? (
                    <p className="cc-muted" style={{ fontSize: '0.75rem' }}>
                      No conversations recorded yet.
                    </p>
                  ) : (
                    <div className="cc-row" style={{ flexWrap: 'wrap', gap: '0.3rem' }}>
                      {customer.sessionIds.map(id => (
                        <span key={id} className="cc-chip cc-chip-neutral">
                          {sessionsById.get(id)?.name ?? id}
                        </span>
                      ))}
                    </div>
                  )}
                </section>

                <section className="contacts-block">
                  <p className="cc-label">Marketing consent</p>
                  {(() => {
                    const status = customer.consent?.status ?? 'unknown';
                    const Icon = CONSENT_META[status].icon;
                    return (
                      <div className={`cc-consent is-${CONSENT_META[status].tone}`}>
                        <Icon size={14} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <strong>{CONSENT_META[status].label}</strong>
                          {customer.consent?.source && (
                            <span className="cc-consent-source">{customer.consent.source}</span>
                          )}
                          {customer.consent?.optedInAt && (
                            <span className="cc-consent-source">
                              Recorded {absoluteTime(customer.consent.optedInAt)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {(customer.consent?.status ?? 'unknown') !== 'opted_in' ? (
                    <div className="cc-row" style={{ gap: '0.35rem', marginTop: '0.5rem' }}>
                      <input
                        className="cc-input"
                        placeholder="How was consent obtained?"
                        value={consentSource}
                        onChange={event => setConsentSource(event.target.value)}
                      />
                      <button
                        type="button"
                        className="cc-btn cc-btn-primary cc-btn-sm"
                        disabled={!consentSource.trim()}
                        onClick={() =>
                          mutations.setConsent.mutate(
                            { waId: customer.waId, status: 'opted_in', source: consentSource.trim() },
                            {
                              onSuccess: () => {
                                success('Opt-in recorded');
                                setConsentSource('');
                              },
                              onError: error =>
                                showError(error instanceof Error ? error.message : 'Could not record consent'),
                            },
                          )
                        }
                      >
                        Record opt-in
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="cc-btn cc-btn-sm cc-btn-danger"
                      style={{ marginTop: '0.5rem' }}
                      onClick={() =>
                        mutations.setConsent.mutate(
                          { waId: customer.waId, status: 'opted_out' },
                          { onSuccess: () => success('Opt-out recorded') },
                        )
                      }
                    >
                      Record opt-out
                    </button>
                  )}
                  <p className="cc-hint">Broadcasts only ever reach contacts with a recorded opt-in.</p>
                </section>

                <section className="contacts-block">
                  <p className="cc-label">Conversations</p>
                  <p className="cc-hint" style={{ marginTop: 0 }}>
                    {customer.conversationIds.length} conversation
                    {customer.conversationIds.length === 1 ? '' : 's'} across {customer.sessionIds.length} number
                    {customer.sessionIds.length === 1 ? '' : 's'}.
                  </p>
                  <Link to="/inbox" className="cc-btn cc-btn-sm">
                    <MessageSquare size={13} /> Open in inbox
                  </Link>
                </section>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default Contacts;
