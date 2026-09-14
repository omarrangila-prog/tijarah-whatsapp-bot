import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

/**
 * A cached AI analysis of a conversation.
 *
 * Cached because analysis is the expensive part of the copilot and a conversation rarely changes
 * between two panel opens. `messageCountAtAnalysis` + `lastMessageAt` are what make the cache
 * honest: the panel shows the cached result only while the conversation has not moved on, and
 * otherwise offers a refresh. Provider and model are recorded so a result can always be attributed.
 */
@Entity('cc_ai_insights')
@Index('IDX_cc_ai_insights_conversationId', ['conversationId'])
export class AiInsight {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  intent!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  sentiment!: 'positive' | 'neutral' | 'negative' | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  language!: string | null;

  /** Bullet points of information worth keeping (order numbers, addresses, deadlines). */
  @Column({ type: jsonColumnType(), nullable: true })
  keyPoints!: string[] | null;

  /** Structured customer details the model extracted, for one-click merge into the profile. */
  @Column({ type: jsonColumnType(), nullable: true })
  extracted!: Record<string, string> | null;

  @Column({ type: 'text', nullable: true })
  suggestedReply!: string | null;

  @Column({ type: 'varchar', length: 240, nullable: true })
  nextBestAction!: string | null;

  @Column({ type: 'varchar', length: 40 })
  provider!: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  model!: string | null;

  /** Message count at analysis time — the cache-staleness oracle. */
  @Column({ type: 'int', default: 0 })
  messageCountAtAnalysis!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
