import { DataSource } from 'typeorm';
import { KnownParty } from './known-party.entity';
import { KnownPartyService } from './known-party.service';
import type { BotUserService, TenantContext } from './bot-user.service';

/**
 * Remembering a customer's name, and turning it back into the account code a ledger needs.
 *
 * Against a real SQLite database rather than a mocked repository: the unique index per
 * company is load-bearing — it is what makes the business renaming a customer an update
 * instead of a second row — and a mock would simply agree that it works.
 */
describe('KnownPartyService', () => {
  let ds: DataSource;
  let service: KnownPartyService;
  let accounts: Array<{ lcode: string; telNo: string | null; email: string | null }>;
  let askedFor: string[];

  const tenant: TenantContext = { whatsAppNo: '923302417530', sid: 1006, grp: 'GR', aYear: '2026', displayName: null };
  const other: TenantContext = { ...tenant, sid: 1007 };

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [KnownParty], synchronize: true });
    await ds.initialize();
    accounts = [];
    askedFor = [];
    const users = {
      findByPhone: (_t: TenantContext, phone: string) => {
        askedFor.push(phone);
        return Promise.resolve(accounts);
      },
    } as unknown as BotUserService;
    service = new KnownPartyService(ds.getRepository(KnownParty), users);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('remembers a name against the dialable form of the number', async () => {
    await service.remember(tenant, 'DANYAL BHAI - (KAUSAR INNOVATIONS)', '0331 3687287');

    expect(await service.list(tenant)).toEqual([
      { name: 'DANYAL BHAI - (KAUSAR INNOVATIONS)', phone: '923313687287', lcode: null },
    ]);
  });

  it('updates the spelling rather than keeping two rows for one customer', async () => {
    await service.remember(tenant, 'DANYAL BHAI', '03313687287');
    await service.remember(tenant, 'DANYAL BHAI - (KAUSAR INNOVATIONS)', '0331 3687287');

    const all = await service.list(tenant);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('DANYAL BHAI - (KAUSAR INNOVATIONS)');
  });

  it('never offers one company a name learned in another', async () => {
    await service.remember(tenant, 'DANYAL BHAI', '03313687287');

    expect(await service.list(other)).toEqual([]);
    expect(await service.find(other, 'danyal')).toEqual({ kind: 'none' });
  });

  it('ignores a blank name or an unusable number instead of storing rubbish', async () => {
    await service.remember(tenant, '   ', '03313687287');
    await service.remember(tenant, 'SOMEBODY', 'not-a-number');

    expect(await service.list(tenant)).toEqual([]);
  });

  it('resolves a found name to its account code, by phone, and caches it', async () => {
    await service.remember(tenant, 'DANYAL BHAI - (KAUSAR INNOVATIONS)', '0331 3687287');
    accounts = [{ lcode: '0107015', telNo: '0331 3687287', email: null }];

    const found = await service.find(tenant, 'danyal');
    expect(found).toEqual({
      kind: 'one',
      party: { name: 'DANYAL BHAI - (KAUSAR INNOVATIONS)', phone: '923313687287', lcode: '0107015' },
    });

    // Cached: a second lookup does not ask the host again.
    askedFor = [];
    const again = await service.find(tenant, 'danyal');
    expect(again.kind === 'one' && again.party.lcode).toBe('0107015');
    expect(askedFor).toEqual([]);
  });

  it('leaves the code unresolved when one number is on several accounts, rather than picking one', async () => {
    await service.remember(tenant, 'CASH CUSTOMER', '03302417530');
    // The host's own data really does have this: 03302417530 is on three accounts.
    accounts = [
      { lcode: '0107077', telNo: '03302417530', email: null },
      { lcode: '0107160', telNo: '03302417530', email: null },
    ];

    const found = await service.find(tenant, 'cash customer');
    expect(found.kind === 'one' && found.party.lcode).toBeNull();
  });

  it('says nothing was found for a customer never seen', async () => {
    await service.remember(tenant, 'DANYAL BHAI', '03313687287');

    expect(await service.find(tenant, 'zubair')).toEqual({ kind: 'none' });
  });

  it('a database failure while remembering never reaches the delivery that triggered it', async () => {
    await ds.destroy();

    await expect(service.remember(tenant, 'DANYAL BHAI', '03313687287')).resolves.toBeUndefined();

    // Re-opened for the afterEach teardown.
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [KnownParty], synchronize: true });
    await ds.initialize();
  });
});
