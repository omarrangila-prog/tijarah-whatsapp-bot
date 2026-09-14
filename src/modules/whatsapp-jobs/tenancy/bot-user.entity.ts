import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * Which Tijarah Books company a WhatsApp number belongs to.
 *
 * `sid` and `grp` are per-client, not per-installation: two businesses can use the same bot,
 * and every document path carries their company and branch. Holding them as defaults on the
 * document-type registry was wrong the moment a second client existed — both would have
 * received company 1006's invoices, which is a data breach with no error message.
 *
 * A number with no row here is not served. There is deliberately no fallback company: an
 * unknown number quietly resolving to whoever was configured first is exactly the failure
 * this table exists to prevent.
 */
@Entity('bot_users')
@Index('IDX_bot_users_phone', ['whatsAppNo'], { unique: true })
export class BotUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Digits only, country code included. The one comparison form used everywhere. */
  @Column({ type: 'varchar', length: 20 })
  whatsAppNo!: string;

  /** Who this is, for the jobs screen. Not used for anything the host sees. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  displayName!: string | null;

  /** The host's company id. Numeric on the wire, so stored as an int. */
  @Column({ type: 'int' })
  sid!: number;

  @Column({ type: 'varchar', length: 16 })
  grp!: string;

  /** Fiscal year. A string because the host treats it as one. */
  @Column({ type: 'varchar', length: 8 })
  aYear!: string;

  /**
   * Whether this number may use the bot at all.
   *
   * Separate from deleting the row so access can be withdrawn without losing the record of
   * which company a past job belonged to.
   */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  createdAt!: Date;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  updatedAt!: Date;
}
