import { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plus,
  Trash2,
  Workflow,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  useFlowExecutionsQuery,
  useFlowMutations,
  useFlowsQuery,
  useQuickRepliesQuery,
  useTagsQuery,
  useAgentsQuery,
  useTeamsQuery,
} from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { EmptyState, ErrorState, Skeleton } from '../components/cc/Primitives';
import { absoluteTime, formatCount } from '../utils/ccFormat';
import type { AutomationFlow, FlowAction, FlowCondition, FlowTrigger } from '../services/commandCenter';
import './Automations.css';

const TRIGGERS: Array<{ value: FlowTrigger; label: string; hint: string }> = [
  { value: 'message_received', label: 'A message is received', hint: 'Runs on every inbound customer message.' },
  { value: 'conversation_created', label: 'A conversation starts', hint: 'The first message from a new contact.' },
  { value: 'label_added', label: 'A label is added', hint: 'When a tag is attached to a conversation.' },
  { value: 'conversation_unresolved', label: 'A conversation stays unresolved', hint: 'After the time you set below.' },
];

const CONDITION_FIELDS: Array<{ value: FlowCondition['field']; label: string }> = [
  { value: 'body', label: 'Message text' },
  { value: 'sessionId', label: 'WhatsApp number' },
  { value: 'chatKind', label: 'Chat type' },
  { value: 'contactTag', label: 'Conversation tag' },
  { value: 'businessHours', label: 'Business hours' },
  { value: 'conversationStatus', label: 'Conversation status' },
  { value: 'conversationPriority', label: 'Priority' },
];

const OPERATORS: Array<{ value: FlowCondition['operator']; label: string }> = [
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'equals', label: 'equals' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'is', label: 'is' },
  { value: 'isNot', label: 'is not' },
];

const ACTION_TYPES: Array<{ value: FlowAction['type']; label: string }> = [
  { value: 'send_reply', label: 'Send a reply' },
  { value: 'add_tag', label: 'Add a tag' },
  { value: 'remove_tag', label: 'Remove a tag' },
  { value: 'assign_agent', label: 'Assign to an agent' },
  { value: 'assign_team', label: 'Assign to a team' },
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_status', label: 'Set status' },
  { value: 'create_follow_up', label: 'Create a follow-up' },
  { value: 'webhook', label: 'Call a webhook' },
];

interface FlowDraft {
  id: string | null;
  name: string;
  description: string;
  sessionId: string;
  trigger: FlowTrigger;
  triggerAfterMinutes: string;
  conditions: FlowCondition[];
  actions: FlowAction[];
  enabled: boolean;
  cooldownSeconds: string;
}

const EMPTY_FLOW: FlowDraft = {
  id: null,
  name: '',
  description: '',
  sessionId: '',
  trigger: 'message_received',
  triggerAfterMinutes: '60',
  conditions: [],
  actions: [{ type: 'add_tag', value: '' }],
  enabled: true,
  cooldownSeconds: '300',
};

/**
 * The WHEN → IF → THEN builder.
 *
 * The editor is a form, not a node canvas: a rule with one trigger, a list of conditions and a list
 * of actions has no branching to draw, and a form states the same thing in a fraction of the space
 * while staying keyboard-navigable and screen-reader legible.
 */
export function Automations() {
  useDocumentTitle('Automations');
  const { success, error: showError } = useToast();
  const { canWrite } = useRole();

  const flowsQuery = useFlowsQuery();
  const executionsQuery = useFlowExecutionsQuery();
  const sessionsQuery = useSessionsQuery();
  const tagsQuery = useTagsQuery();
  const agentsQuery = useAgentsQuery();
  const teamsQuery = useTeamsQuery();
  const quickRepliesQuery = useQuickRepliesQuery();
  const mutations = useFlowMutations();

  const [draft, setDraft] = useState<FlowDraft | null>(null);
  const [tab, setTab] = useState<'flows' | 'log'>('flows');

  const flows = useMemo(() => flowsQuery.data ?? [], [flowsQuery.data]);
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const sessionsById = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);

  const toDraft = (flow: AutomationFlow): FlowDraft => ({
    id: flow.id,
    name: flow.name,
    description: flow.description ?? '',
    sessionId: flow.sessionId ?? '',
    trigger: flow.trigger,
    triggerAfterMinutes: String(flow.triggerAfterMinutes ?? 60),
    conditions: flow.conditions ?? [],
    actions: flow.actions ?? [],
    enabled: flow.enabled,
    cooldownSeconds: String(flow.cooldownSeconds),
  });

  const save = () => {
    if (!draft) return;
    const payload: Partial<AutomationFlow> = {
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      sessionId: draft.sessionId || undefined,
      trigger: draft.trigger,
      ...(draft.trigger === 'conversation_unresolved'
        ? { triggerAfterMinutes: Number(draft.triggerAfterMinutes) || 60 }
        : {}),
      conditions: draft.conditions,
      actions: draft.actions,
      enabled: draft.enabled,
      cooldownSeconds: Number(draft.cooldownSeconds) || 0,
    };
    const handlers = {
      onSuccess: () => {
        success(draft.id ? 'Automation updated' : 'Automation created');
        setDraft(null);
      },
      onError: (error: unknown) => showError(error instanceof Error ? error.message : 'Could not save the automation'),
    };
    if (draft.id) mutations.update.mutate({ id: draft.id, ...payload }, handlers);
    else mutations.create.mutate(payload, handlers);
  };

  /** Value editor for an action, which differs per action type. */
  const renderActionValue = (action: FlowAction, index: number) => {
    const patch = (changes: Partial<FlowAction>) =>
      setDraft(current =>
        current
          ? { ...current, actions: current.actions.map((item, i) => (i === index ? { ...item, ...changes } : item)) }
          : current,
      );

    switch (action.type) {
      case 'send_reply':
        return (
          <div className="cc-stack" style={{ gap: '0.35rem' }}>
            <select
              className="cc-select"
              aria-label="Reply source"
              value={action.quickReplyId ?? ''}
              onChange={event => patch({ quickReplyId: event.target.value || undefined, value: undefined })}
            >
              <option value="">Write custom text…</option>
              {(quickRepliesQuery.data ?? []).map(reply => (
                <option key={reply.id} value={reply.id}>
                  /{reply.shortcut} — {reply.title}
                </option>
              ))}
            </select>
            {!action.quickReplyId && (
              <textarea
                className="cc-textarea"
                rows={2}
                placeholder="Reply text. Supports {{name}} and {{phone}}."
                value={action.value ?? ''}
                onChange={event => patch({ value: event.target.value })}
              />
            )}
            <p className="cc-hint">
              Prefer a quick reply — automation then sends only copy a human has approved, editable in one place.
            </p>
          </div>
        );
      case 'add_tag':
      case 'remove_tag':
        return (
          <input
            className="cc-input"
            list="flow-tag-options"
            placeholder="Tag name"
            value={action.value ?? ''}
            onChange={event => patch({ value: event.target.value })}
          />
        );
      case 'assign_agent':
        return (
          <select
            className="cc-select"
            aria-label="Agent to assign"
            value={action.value ?? ''}
            onChange={event => patch({ value: event.target.value })}
          >
            <option value="">Unassign</option>
            {(agentsQuery.data ?? []).map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        );
      case 'assign_team':
        return (
          <select
            className="cc-select"
            aria-label="Team to assign"
            value={action.value ?? ''}
            onChange={event => patch({ value: event.target.value })}
          >
            <option value="">No team</option>
            {(teamsQuery.data ?? []).map(team => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        );
      case 'set_priority':
        return (
          <select
            className="cc-select"
            aria-label="Priority to set"
            value={action.value ?? 'normal'}
            onChange={event => patch({ value: event.target.value })}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        );
      case 'set_status':
        return (
          <select
            className="cc-select"
            aria-label="Status to set"
            value={action.value ?? 'open'}
            onChange={event => patch({ value: event.target.value })}
          >
            <option value="open">Open</option>
            <option value="waiting">Waiting</option>
            <option value="resolved">Resolved</option>
          </select>
        );
      case 'create_follow_up':
        return (
          <div className="cc-row" style={{ gap: '0.35rem' }}>
            <input
              className="cc-input"
              placeholder="Follow-up title"
              value={action.value ?? ''}
              onChange={event => patch({ value: event.target.value })}
            />
            <input
              className="cc-input"
              type="number"
              min={1}
              style={{ maxWidth: 110 }}
              placeholder="Minutes"
              value={action.dueInMinutes ?? 60}
              onChange={event => patch({ dueInMinutes: Number(event.target.value) })}
            />
          </div>
        );
      case 'webhook':
        return (
          <input
            className="cc-input"
            type="url"
            placeholder="https://example.com/hook"
            value={action.url ?? ''}
            onChange={event => patch({ url: event.target.value })}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="cc-page auto">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Automations</h1>
          <p className="cc-page-sub">
            When something happens, if your conditions hold, then act. Every run is logged — including the ones that
            were skipped and why.
          </p>
        </div>
        <div className="cc-row">
          <div className="cc-range" role="tablist">
            <button type="button" className={`cc-range-btn ${tab === 'flows' ? 'is-active' : ''}`} onClick={() => setTab('flows')}>
              Flows
            </button>
            <button type="button" className={`cc-range-btn ${tab === 'log' ? 'is-active' : ''}`} onClick={() => setTab('log')}>
              Execution log
            </button>
          </div>
          <button type="button" className="cc-btn cc-btn-primary" onClick={() => setDraft({ ...EMPTY_FLOW })} disabled={!canWrite}>
            <Plus size={14} /> New automation
          </button>
        </div>
      </header>

      <datalist id="flow-tag-options">
        {(tagsQuery.data ?? []).map(tag => (
          <option key={tag.id} value={tag.name} />
        ))}
      </datalist>

      {tab === 'log' ? (
        <div className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">Recent executions</h2>
            <button type="button" className="cc-btn cc-btn-ghost cc-btn-sm" onClick={() => void executionsQuery.refetch()}>
              Refresh
            </button>
          </div>
          <div className="cc-table-scroll">
            {executionsQuery.isLoading ? (
              <div style={{ padding: '1rem' }}>
                <Skeleton height={44} />
              </div>
            ) : executionsQuery.error ? (
              <div style={{ padding: '1rem' }}>
                <ErrorState error={executionsQuery.error} onRetry={() => void executionsQuery.refetch()} />
              </div>
            ) : (executionsQuery.data ?? []).length === 0 ? (
              <EmptyState
                icon={<Workflow size={20} />}
                title="No executions yet"
                description="Runs appear here as soon as an automation matches an incoming message."
              />
            ) : (
              <table className="cc-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Flow</th>
                    <th>Outcome</th>
                    <th>Chat</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(executionsQuery.data ?? []).map(execution => (
                    <tr key={execution.id}>
                      <td className="cc-num">{absoluteTime(execution.createdAt)}</td>
                      <td>{execution.flowName ?? execution.flowId}</td>
                      <td>
                        <span className={`cc-chip cc-chip-${execution.outcome === 'matched' ? 'resolved' : execution.outcome === 'failed' ? 'urgent' : 'neutral'}`}>
                          {execution.outcome === 'matched' ? <CheckCircle2 size={10} /> : execution.outcome === 'failed' ? <XCircle size={10} /> : <AlertCircle size={10} />}
                          {execution.outcome}
                        </span>
                        {execution.reason && <div className="auto-reason">{execution.reason}</div>}
                      </td>
                      <td className="cc-truncate" style={{ maxWidth: 180 }}>
                        {execution.chatId ?? '—'}
                      </td>
                      <td>
                        {(execution.actionResults ?? []).length === 0
                          ? '—'
                          : (execution.actionResults ?? []).map((result, index) => (
                              <span key={index} className={`auto-action-result ${result.ok ? 'is-ok' : 'is-bad'}`} title={result.detail}>
                                {result.type}
                              </span>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="auto-layout">
          <div className="auto-list">
            {flowsQuery.isLoading ? (
              <Skeleton height={100} radius="var(--cc-radius-lg)" />
            ) : flowsQuery.error ? (
              <ErrorState error={flowsQuery.error} onRetry={() => void flowsQuery.refetch()} />
            ) : flows.length === 0 ? (
              <div className="cc-card">
                <EmptyState
                  icon={<Workflow size={20} />}
                  title="No automations yet"
                  description="Route pricing questions to Sales, escalate complaints, or send an after-hours acknowledgement — without anyone watching the inbox."
                  action={
                    canWrite ? (
                      <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={() => setDraft({ ...EMPTY_FLOW })}>
                        <Plus size={13} /> Create your first automation
                      </button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              flows.map(flow => (
                <article key={flow.id} className={`cc-card auto-card ${flow.enabled ? '' : 'is-disabled'}`}>
                  <div className="auto-card-head">
                    <span className={`cc-dot ${flow.enabled ? 'cc-dot-ready' : ''}`} />
                    <h3 className="auto-card-name cc-truncate">{flow.name}</h3>
                    <span className="cc-chip cc-chip-neutral cc-num">{formatCount(flow.executionCount)} runs</span>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() =>
                        mutations.update.mutate(
                          { id: flow.id, enabled: !flow.enabled },
                          { onSuccess: () => success(flow.enabled ? 'Automation paused' : 'Automation enabled') },
                        )
                      }
                      disabled={!canWrite}
                    >
                      {flow.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button type="button" className="cc-btn cc-btn-ghost cc-btn-sm" onClick={() => setDraft(toDraft(flow))} disabled={!canWrite}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() => mutations.remove.mutate(flow.id, { onSuccess: () => success('Automation deleted') })}
                      disabled={!canWrite}
                      aria-label={`Delete ${flow.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  {flow.description && <p className="auto-card-desc">{flow.description}</p>}

                  <div className="auto-flow">
                    <span className="auto-step auto-step-when">
                      <b>When</b>
                      {TRIGGERS.find(trigger => trigger.value === flow.trigger)?.label ?? flow.trigger}
                    </span>
                    <ChevronRight size={13} />
                    <span className="auto-step auto-step-if">
                      <b>If</b>
                      {(flow.conditions ?? []).length === 0
                        ? 'always'
                        : (flow.conditions ?? [])
                            .map(
                              condition =>
                                `${CONDITION_FIELDS.find(f => f.value === condition.field)?.label ?? condition.field} ${condition.operator} "${condition.value}"`,
                            )
                            .join(' and ')}
                    </span>
                    <ChevronRight size={13} />
                    <span className="auto-step auto-step-then">
                      <b>Then</b>
                      {flow.actions.map(action => ACTION_TYPES.find(a => a.value === action.type)?.label ?? action.type).join(', ')}
                    </span>
                  </div>

                  <div className="auto-card-foot">
                    <span>{flow.sessionId ? (sessionsById.get(flow.sessionId)?.name ?? flow.sessionId) : 'All numbers'}</span>
                    <span>·</span>
                    <span>{flow.cooldownSeconds}s cooldown per conversation</span>
                  </div>
                </article>
              ))
            )}
          </div>

          {draft && (
            <aside className="cc-card auto-editor">
              <div className="cc-card-head">
                <h2 className="cc-card-title">{draft.id ? 'Edit automation' : 'New automation'}</h2>
              </div>
              <div className="cc-card-body">
                <label className="cc-field">
                  <span>Name</span>
                  <input className="cc-input" value={draft.name} placeholder="Route pricing enquiries" onChange={event => setDraft({ ...draft, name: event.target.value })} />
                </label>
                <label className="cc-field">
                  <span>Description</span>
                  <input className="cc-input" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />
                </label>
                <label className="cc-field">
                  <span>Applies to</span>
                  <select
                    className="cc-select"
                    aria-label="Applies to"
                    value={draft.sessionId}
                    onChange={event => setDraft({ ...draft, sessionId: event.target.value })}
                  >
                    <option value="">All WhatsApp numbers</option>
                    {sessions.map(session => (
                      <option key={session.id} value={session.id}>
                        {session.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="auto-block auto-block-when">
                  <p className="cc-label">When</p>
                  <select
                    className="cc-select"
                    aria-label="Trigger"
                    value={draft.trigger}
                    onChange={event => setDraft({ ...draft, trigger: event.target.value as FlowTrigger })}
                  >
                    {TRIGGERS.map(trigger => (
                      <option key={trigger.value} value={trigger.value}>
                        {trigger.label}
                      </option>
                    ))}
                  </select>
                  <p className="cc-hint">{TRIGGERS.find(trigger => trigger.value === draft.trigger)?.hint}</p>
                  {draft.trigger === 'conversation_unresolved' && (
                    <input
                      className="cc-input"
                      type="number"
                      min={1}
                      style={{ marginTop: '0.4rem' }}
                      value={draft.triggerAfterMinutes}
                      onChange={event => setDraft({ ...draft, triggerAfterMinutes: event.target.value })}
                      aria-label="Minutes unresolved"
                    />
                  )}
                </div>

                <div className="auto-block auto-block-if">
                  <div className="cc-row-between">
                    <p className="cc-label" style={{ margin: 0 }}>
                      If
                    </p>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() =>
                        setDraft({ ...draft, conditions: [...draft.conditions, { field: 'body', operator: 'contains', value: '' }] })
                      }
                    >
                      <Plus size={12} /> Condition
                    </button>
                  </div>
                  {draft.conditions.length === 0 ? (
                    <p className="cc-hint" style={{ marginTop: 0 }}>
                      No conditions — the automation runs on every matching trigger.
                    </p>
                  ) : (
                    draft.conditions.map((condition, index) => (
                      <div key={index} className="auto-condition">
                        <select
                          className="cc-select"
                          aria-label={`Condition ${index + 1} field`}
                          value={condition.field}
                          onChange={event =>
                            setDraft({
                              ...draft,
                              conditions: draft.conditions.map((item, i) =>
                                i === index ? { ...item, field: event.target.value as FlowCondition['field'] } : item,
                              ),
                            })
                          }
                        >
                          {CONDITION_FIELDS.map(field => (
                            <option key={field.value} value={field.value}>
                              {field.label}
                            </option>
                          ))}
                        </select>
                        <select
                          className="cc-select"
                          aria-label={`Condition ${index + 1} operator`}
                          value={condition.operator}
                          onChange={event =>
                            setDraft({
                              ...draft,
                              conditions: draft.conditions.map((item, i) =>
                                i === index ? { ...item, operator: event.target.value as FlowCondition['operator'] } : item,
                              ),
                            })
                          }
                        >
                          {OPERATORS.map(operator => (
                            <option key={operator.value} value={operator.value}>
                              {operator.label}
                            </option>
                          ))}
                        </select>
                        {condition.field === 'businessHours' ? (
                          <select
                            className="cc-select"
                            aria-label={`Condition ${index + 1} value`}
                            value={condition.value || 'true'}
                            onChange={event =>
                              setDraft({
                                ...draft,
                                conditions: draft.conditions.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)),
                              })
                            }
                          >
                            <option value="true">open</option>
                            <option value="false">closed</option>
                          </select>
                        ) : (
                          <input
                            className="cc-input"
                            placeholder="value"
                            value={condition.value}
                            onChange={event =>
                              setDraft({
                                ...draft,
                                conditions: draft.conditions.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)),
                              })
                            }
                          />
                        )}
                        <button
                          type="button"
                          className="cc-btn cc-btn-ghost cc-btn-sm"
                          onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}
                          aria-label="Remove condition"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="auto-block auto-block-then">
                  <div className="cc-row-between">
                    <p className="cc-label" style={{ margin: 0 }}>
                      Then
                    </p>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() => setDraft({ ...draft, actions: [...draft.actions, { type: 'add_tag', value: '' }] })}
                    >
                      <Plus size={12} /> Action
                    </button>
                  </div>
                  {draft.actions.map((action, index) => (
                    <div key={index} className="auto-action">
                      <div className="cc-row" style={{ gap: '0.35rem' }}>
                        <select
                          className="cc-select"
                          aria-label={`Action ${index + 1} type`}
                          value={action.type}
                          onChange={event =>
                            setDraft({
                              ...draft,
                              actions: draft.actions.map((item, i) =>
                                i === index ? ({ type: event.target.value as FlowAction['type'] } as FlowAction) : item,
                              ),
                            })
                          }
                        >
                          {ACTION_TYPES.map(type => (
                            <option key={type.value} value={type.value}>
                              {type.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="cc-btn cc-btn-ghost cc-btn-sm"
                          onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) })}
                          disabled={draft.actions.length === 1}
                          aria-label="Remove action"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <div style={{ marginTop: '0.35rem' }}>{renderActionValue(action, index)}</div>
                    </div>
                  ))}
                </div>

                <label className="cc-field" style={{ marginTop: '1rem' }}>
                  <span>Cooldown per conversation (seconds)</span>
                  <input
                    className="cc-input"
                    type="number"
                    min={0}
                    value={draft.cooldownSeconds}
                    onChange={event => setDraft({ ...draft, cooldownSeconds: event.target.value })}
                  />
                  <p className="cc-hint">
                    This is the loop guard: it stops the same automation firing repeatedly into one conversation. Lower
                    it knowingly.
                  </p>
                </label>

                <label className="cc-row" style={{ gap: '0.4rem', marginBottom: '1rem' }}>
                  <input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
                  <span style={{ fontSize: '0.8125rem' }}>Enabled</span>
                </label>

                <div className="cc-row" style={{ gap: '0.4rem' }}>
                  <button
                    type="button"
                    className="cc-btn cc-btn-primary"
                    onClick={save}
                    disabled={!draft.name.trim() || draft.actions.length === 0 || mutations.create.isPending || mutations.update.isPending}
                  >
                    {mutations.create.isPending || mutations.update.isPending ? <Loader2 size={13} className="cc-spin" /> : <Zap size={13} />}
                    {draft.id ? 'Save changes' : 'Create automation'}
                  </button>
                  <button type="button" className="cc-btn" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

export default Automations;
