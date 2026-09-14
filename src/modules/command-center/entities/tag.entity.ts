import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * An organization-level tag vocabulary.
 *
 * Distinct from `sessions/:id/labels`, which are WhatsApp Business labels living on the account
 * itself: those are engine-owned, per-number, and only exist on Business accounts. These are the
 * gateway's own tags — available on every number, usable by automation, and unaffected by whichever
 * device is linked. Both are shown in the UI; neither is a copy of the other.
 */
@Entity('cc_tags')
@Index('IDX_cc_tags_name', ['name'], { unique: true })
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'varchar', length: 9, default: '#6366f1' })
  color!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
