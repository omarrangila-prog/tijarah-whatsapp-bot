import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export enum ConsentStatus {
  /** No recorded decision. Treated exactly like OPTED_OUT by the broadcast gate — never messaged. */
  UNKNOWN = 'unknown',
  OPTED_IN = 'opted_in',
  OPTED_OUT = 'opted_out',
}

/**
 * Marketing consent, recorded separately from the customer profile on purpose.
 *
 * Consent is the gate every broadcast passes through, so it needs its own auditable row with its own
 * timestamps and recorded source — an operator editing a profile's company name must not be able to
 * touch it as a side effect, and "when and how did this person opt in" has to survive profile edits.
 * The broadcast audience builder admits ONLY `opted_in`.
 */
@Entity('cc_contact_consent')
@Index('IDX_cc_contact_consent_waId', ['waId'], { unique: true })
@Index('IDX_cc_contact_consent_status', ['status'])
export class ContactConsent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 190 })
  waId!: string;

  @Column({ type: 'varchar', length: 20, default: ConsentStatus.UNKNOWN })
  status!: ConsentStatus;

  /** How consent was obtained — required by the DTO when moving to OPTED_IN. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  source!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  optedInAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  optedOutAt!: Date | null;

  /** Who recorded the change, for the audit trail. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  recordedBy!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
