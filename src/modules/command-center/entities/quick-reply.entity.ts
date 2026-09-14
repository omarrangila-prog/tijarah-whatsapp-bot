import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A saved reply, addressed by a `/shortcut` in the composer.
 *
 * Distinct from the existing per-session `templates` table, which models WhatsApp message templates
 * (header/body/footer, bound to one session). A quick reply is an agent-productivity object: global
 * to the workspace, organised into folders, and interpolated with `{{name}}`/`{{phone}}`/
 * `{{agent_name}}` at insert time.
 */
@Entity('cc_quick_replies')
@Index('IDX_cc_quick_replies_shortcut', ['shortcut'], { unique: true })
@Index('IDX_cc_quick_replies_folder', ['folder'])
export class QuickReply {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stored WITHOUT the leading slash, lowercased. The composer adds the '/' when displaying. */
  @Column({ type: 'varchar', length: 40 })
  shortcut!: string;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'varchar', length: 60, default: 'General' })
  folder!: string;

  /** Incremented each time the reply is inserted into a composer — drives "most used" ordering. */
  @Column({ type: 'int', default: 0 })
  useCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
