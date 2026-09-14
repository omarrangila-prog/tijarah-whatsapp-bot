import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/** Immutable trail of every assignment change on a conversation. Never updated, only appended. */
@Entity('cc_assignment_history')
@Index('IDX_cc_assignment_history_conversationId', ['conversationId'])
export class AssignmentHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @Column({ type: 'varchar', length: 20 })
  action!: 'assigned' | 'reassigned' | 'unassigned' | 'claimed' | 'team_assigned';

  @Column({ type: 'varchar', nullable: true })
  fromAgentId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  toAgentId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  teamId!: string | null;

  /** Who performed it — an agent id when resolvable, otherwise the API key name. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  actor!: string | null;

  @Column({ type: 'varchar', length: 240, nullable: true })
  reason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
