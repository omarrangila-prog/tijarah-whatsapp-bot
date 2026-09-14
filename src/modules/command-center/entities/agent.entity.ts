import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * A human operator of the command center.
 *
 * OpenWA authenticates with API keys, not user accounts, so an agent is the *identity* an API key
 * acts as: `apiKeyId` links the row to `api_keys.id` on the MAIN connection. It is deliberately a
 * plain varchar and NOT a foreign key — the two live on different connections (and on different
 * database engines when DATABASE_TYPE=postgres), so a real FK is not expressible. Agents without a
 * key are still useful: a conversation can be assigned to a teammate who has not been issued one.
 */
@Entity('cc_agents')
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 190, nullable: true })
  email!: string | null;

  /**
   * `api_keys.id` on the main connection. Indexed (not UNIQUE): a partial unique index is the only
   * correct shape here — NULL means "no key linked" and many agents may be unlinked — and its
   * predicate has to be quoted differently on each dialect. AgentService enforces the one-key-one-
   * agent rule on write instead, where it can return a clear 409.
   */
  @Index('IDX_cc_agents_apiKeyId')
  @Column({ type: 'varchar', length: 64, nullable: true })
  apiKeyId!: string | null;

  /** Mirrors the API-key role vocabulary so the UI can show it without a cross-connection join. */
  @Column({ type: 'varchar', length: 20, default: 'operator' })
  role!: 'admin' | 'operator' | 'viewer';

  /** Avatar tint, chosen at creation. Hex, validated at the DTO. */
  @Column({ type: 'varchar', length: 9, default: '#25d366' })
  color!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastSeenAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
