import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * The CRM record for a person, keyed by their normalized WhatsApp id.
 *
 * It stores only what the gateway does NOT already know: the business context an operator types in
 * (company, email, source, custom fields). Display name, profile picture and presence are still read
 * from the engine at request time and are never copied here — those change on WhatsApp's side and a
 * cached copy would go stale silently. `displayName` is the one exception and is explicitly an
 * operator OVERRIDE, used only when set.
 *
 * `waId` is normalized (digits + '@c.us' where the id is a phone) so the same person reached through
 * two sessions is one profile.
 */
@Entity('cc_customer_profiles')
@Index('IDX_cc_customer_profiles_waId', ['waId'], { unique: true })
@Index('IDX_cc_customer_profiles_phone', ['phone'])
export class CustomerProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 190 })
  waId!: string;

  /** MSISDN digits when resolvable, otherwise null (an @lid contact that never resolved). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  /** Operator-set override. Null means "use whatever the engine reports". */
  @Column({ type: 'varchar', length: 120, nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  company!: string | null;

  @Column({ type: 'varchar', length: 190, nullable: true })
  email!: string | null;

  /** Where this customer came from: 'inbound', 'import', 'referral', a campaign name, … */
  @Column({ type: 'varchar', length: 60, nullable: true })
  source!: string | null;

  /** Free-form segmentation used by broadcast audiences ('lead', 'customer', 'vip', …). */
  @Column({ type: 'varchar', length: 60, nullable: true })
  customerType!: string | null;

  @Column({ type: 'varchar', length: 90, nullable: true })
  city!: string | null;

  /** Operator-defined key/value pairs. Keys are validated at the DTO; values are strings. */
  @Column({ type: jsonColumnType(), nullable: true })
  customFields!: Record<string, string> | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  firstInteractionAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastInteractionAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
