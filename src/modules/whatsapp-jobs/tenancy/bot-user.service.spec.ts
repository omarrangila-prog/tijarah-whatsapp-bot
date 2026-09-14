import { createServer, type Server } from 'node:http';
import { DataSource } from 'typeorm';
import { BotUser } from './bot-user.entity';
import { BotUserService, toLocalForm, type HostClient } from './bot-user.service';

/**
 * A stand-in for Tijarah's client directory, over a real socket.
 *
 * `GetBotTijarahClient` was not deployed when this was written; the shape is the one the host
 * documented. Running it over HTTP rather than a stubbed client means the query string and the
 * fallback between phone spellings are what is tested, not what the service believes it sent.
 */
function startDirectory(
  answer: (query: URLSearchParams) => HostClient[],
): Promise<{ server: Server; base: string; asked: string[] }> {
  const asked: string[] = [];
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      asked.push(url.search);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'OK', data: answer(url.searchParams) }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${port}`, asked });
    });
  });
}

const TESTING: HostClient = {
  sid: 1006,
  grp: 'GR',
  cont: '03000000000',
  email: 'user@gmail.com',
  businessName: 'Testing Company',
  businessAddress: 'Karachi',
};
const SECOND: HostClient = { ...TESTING, sid: 1007, businessName: 'Second Traders' };

describe('resolving a number through the host directory', () => {
  let ds: DataSource;
  let service: BotUserService;
  let directory: { server: Server; base: string; asked: string[] };

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [BotUser], synchronize: true });
    await ds.initialize();
    service = new BotUserService(ds.getRepository(BotUser));
  });

  afterEach(async () => {
    await ds.destroy();
    directory?.server.close();
    delete process.env.TIJARAH_QUEUE_BASE_URL;
  });

  const point = (d: { base: string }) => {
    process.env.TIJARAH_QUEUE_BASE_URL = d.base;
  };

  it('asks by phone in the local form, the way the directory stores numbers', async () => {
    directory = await startDirectory(q => (q.get('cont') === '03000000000' ? [TESTING] : []));
    point(directory);

    const outcome = await service.lookup('923000000000');

    expect(outcome.kind).toBe('registered');
    expect(directory.asked[0]).toContain('cont=03000000000');
    expect(directory.asked[0]).toContain('email=0');
    expect(directory.asked[0]).toContain('bname=0');
  });

  it('falls back to the international form before giving up', async () => {
    directory = await startDirectory(q => (q.get('cont') === '923000000000' ? [TESTING] : []));
    point(directory);

    const outcome = await service.lookup('03000000000');

    expect(outcome.kind).toBe('registered');
    expect(directory.asked).toHaveLength(2);
  });

  it('remembers one answer so the directory is asked once per number', async () => {
    directory = await startDirectory(() => [TESTING]);
    point(directory);

    const first = await service.lookup('923000000000');
    const second = await service.lookup('923000000000');

    expect(first.kind).toBe('registered');
    expect(second).toEqual(first);
    expect(directory.asked).toHaveLength(1);
    const rows = await ds.getRepository(BotUser).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sid: 1006, grp: 'GR', displayName: 'Testing Company' });
    expect(rows[0].aYear).toBe(String(new Date().getFullYear()));
  });

  it('hands back the choices when a number is on more than one account, and serves nothing', async () => {
    directory = await startDirectory(() => [TESTING, SECOND]);
    point(directory);

    const outcome = await service.lookup('923000000000');

    expect(outcome.kind).toBe('ambiguous');
    expect(await service.resolve('923000000000')).toBeNull();
    expect(await ds.getRepository(BotUser).count()).toBe(0);
  });

  it('settles the choice by name or by position, and refuses a guess', async () => {
    const choices = [TESTING, SECOND];

    expect((await service.choose('923000000000', 'second traders', choices))?.sid).toBe(1007);
    expect((await service.choose('923000000000', '1', choices))?.sid).toBe(1006);
    // "traders" is in one name only; "company" would match neither exactly nor uniquely.
    expect(await service.choose('923000000000', 'x', choices)).toBeNull();
    expect(await service.choose('923000000000', '', choices)).toBeNull();
  });

  it('is unknown, never a default, when the directory has nobody or is down', async () => {
    directory = await startDirectory(() => []);
    point(directory);
    expect((await service.lookup('923000000000')).kind).toBe('unknown');

    process.env.TIJARAH_QUEUE_BASE_URL = 'http://127.0.0.1:1';
    expect((await service.lookup('923000000000')).kind).toBe('unknown');
  });

  it('prefers what an administrator wrote over what the directory says', async () => {
    directory = await startDirectory(() => [SECOND]);
    point(directory);
    await service.upsert({ whatsAppNo: '923000000000', sid: 1006, grp: 'GR', aYear: '2026' });

    const outcome = await service.lookup('923000000000');

    expect(outcome.kind === 'registered' && outcome.tenant.sid).toBe(1006);
    expect(directory.asked).toHaveLength(0);
  });

  it('drops a directory row with no company in it', async () => {
    directory = await startDirectory(() => [{ sid: 0, grp: '' } as HostClient, TESTING]);
    point(directory);

    const outcome = await service.lookup('923000000000');

    expect(outcome.kind).toBe('registered');
  });
});

describe('phone spellings', () => {
  it('turns the WhatsApp form into the local one the directory stores', () => {
    expect(toLocalForm('923000000000')).toBe('03000000000');
    expect(toLocalForm('03000000000')).toBe('03000000000');
    expect(toLocalForm('447700900123')).toBe('447700900123');
  });
});
