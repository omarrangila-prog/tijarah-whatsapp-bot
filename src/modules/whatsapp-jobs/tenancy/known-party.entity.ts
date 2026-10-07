import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * A customer's name, learned from a document the host sent them.
 *
 * Tijarah's account list (`GetBotCustomers`) carries `lcode`, `telNo` and `email` and **no
 * name**, so "send me Danyal's ledger" had nothing to match against and a person had to quote
 * an account code. The queue (`GetPendingBotInvoices`) does carry one, as `contactName`
 * alongside `contactNumber` — but only for a document already being delivered, which is a
 * fact passing through rather than a directory.
 *
 * So the names are kept as they go past. Each row is one name the business itself used for a
 * customer, in one company's books; the account code is resolved separately, by matching the
 * phone against the account list, because a name is how a person refers to someone and a code
 * is what a ledger is fetched by.
 *
 * Nothing here widens what anyone may see: a row is scoped to the `sid`/`grp` it was learned
 * in, and every lookup is filtered by the asking client's own company.
 */
@Entity('known_parties')
@Index('IDX_known_parties_tenant_phone', ['sid', 'grp', 'phone'], { unique: true })
@Index('IDX_known_parties_tenant', ['sid', 'grp'])
export class KnownParty {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The company whose books this name was seen in. Never crossed. */
  @Column({ type: 'int' })
  sid!: number;

  @Column({ type: 'varchar', length: 16 })
  grp!: string;

  /** Digits only, the same comparison form as everywhere else. The join to an account code. */
  @Column({ type: 'varchar', length: 20 })
  phone!: string;

  /** As the business wrote it, e.g. "DANYAL BHAI - (KAUSAR INNOVATIONS)". Shown back verbatim. */
  @Column({ type: 'varchar', length: 190 })
  name!: string;

  /**
   * The account code, once a phone match in `GetBotCustomers` has been confirmed.
   *
   * Null while unresolved, and deliberately not guessed: a phone on two accounts is a question
   * for a person, because the wrong answer sends someone another customer's ledger.
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  lcode!: string | null;

  /** When this name was last seen on a document, so the most recent spelling wins. */
  @Column({ type: dateColumnType(), transformer: DateTransformer })
  lastSeenAt!: Date;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  createdAt!: Date;
}
