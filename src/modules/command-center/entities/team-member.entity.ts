import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

/** agent ↔ team membership. An agent may belong to several teams. */
@Entity('cc_team_members')
@Unique('UQ_cc_team_members_team_agent', ['teamId', 'agentId'])
export class TeamMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_cc_team_members_teamId')
  @Column({ type: 'varchar' })
  teamId!: string;

  @Index('IDX_cc_team_members_agentId')
  @Column({ type: 'varchar' })
  agentId!: string;

  /** Role WITHIN the team (who can reassign), independent of the API-key role. */
  @Column({ type: 'varchar', length: 20, default: 'member' })
  teamRole!: 'lead' | 'member';

  @CreateDateColumn()
  createdAt!: Date;
}
