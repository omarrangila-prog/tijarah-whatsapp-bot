import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/** A routing target: conversations can be assigned to a team as well as to an individual agent. */
@Entity('cc_teams')
export class Team {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_cc_teams_name', { unique: true })
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 240, nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 9, default: '#2563eb' })
  color!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
