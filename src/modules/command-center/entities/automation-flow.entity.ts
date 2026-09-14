import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

/** WHEN — what starts a flow. */
export enum FlowTrigger {
  MESSAGE_RECEIVED = 'message_received',
  CONVERSATION_CREATED = 'conversation_created',
  LABEL_ADDED = 'label_added',
  CONVERSATION_UNRESOLVED = 'conversation_unresolved',
}

/** THEN — one step of the action list. Discriminated by `type`. */
export interface FlowAction {
  type:
    | 'send_reply'
    | 'add_tag'
    | 'remove_tag'
    | 'assign_agent'
    | 'assign_team'
    | 'set_priority'
    | 'set_status'
    | 'create_follow_up'
    | 'webhook';
  /** Action-specific payload; validated per type by the DTO validator, not by TypeORM. */
  value?: string;
  /** `send_reply` only — a quick-reply id, so approved copy is reused rather than free text. */
  quickReplyId?: string;
  /** `create_follow_up` only. */
  dueInMinutes?: number;
  /** `webhook` only. */
  url?: string;
}

/** IF — one condition. Evaluated by the flow evaluator, not by the webhook filter DSL. */
export interface FlowCondition {
  field:
    'body' | 'sessionId' | 'chatKind' | 'contactTag' | 'businessHours' | 'conversationStatus' | 'conversationPriority';
  operator: 'contains' | 'equals' | 'startsWith' | 'notContains' | 'is' | 'isNot';
  value: string;
  caseSensitive?: boolean;
}

/**
 * A visual WHEN → IF → THEN rule.
 *
 * Deliberately a NEW table rather than a widening of `automation_rules`: that table is the existing
 * single-message autoreply and its rows are load-bearing for deployments already using it. A flow is
 * a superset (many actions, more condition types, an execution log), so widening the old shape would
 * have meant migrating live rules into a semantics they were not written for. Both evaluate on the
 * same inbound dispatch; the autoreply runs first and is unchanged.
 *
 * `sessionId` NULL means the flow applies to every number.
 */
@Entity('cc_automation_flows')
@Index('IDX_cc_automation_flows_enabled', ['enabled'])
export class AutomationFlow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 240, nullable: true })
  description!: string | null;

  /** Null = all sessions. */
  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  @Column({ type: 'varchar', length: 40, default: FlowTrigger.MESSAGE_RECEIVED })
  trigger!: FlowTrigger;

  /** For CONVERSATION_UNRESOLVED: how long unresolved before the flow fires. */
  @Column({ type: 'int', nullable: true })
  triggerAfterMinutes!: number | null;

  /** ALL conditions must hold. An empty list matches everything. */
  @Column({ type: jsonColumnType(), nullable: true })
  conditions!: FlowCondition[] | null;

  @Column({ type: jsonColumnType() })
  actions!: FlowAction[];

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /**
   * Per-(flow, conversation) quiet period. Together with the loop guard in the evaluator this is
   * what stops two flows — or a flow and an autoreply — from answering each other indefinitely.
   */
  @Column({ type: 'int', default: 300 })
  cooldownSeconds!: number;

  @Column({ type: 'int', default: 0 })
  executionCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
