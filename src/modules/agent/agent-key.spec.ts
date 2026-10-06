import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentRuntime } from './agent-runtime.service';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { defineTool } from '../../core/agent-tools/tool-descriptor';

/**
 * The key the agent acts as must always be obtainable.
 *
 * On the first live deployment the database was rebuilt, the AGENT_API_KEY pasted into .env
 * stopped existing, and every client request answered "The tool failed: Invalid API key" — twice,
 * through two rounds of manual fixes. The agent now provisions and recovers its own key.
 */
describe('the agent API key', () => {
  let dir: string;
  let valid: Set<string>;
  let minted: string[];

  const auth = () => ({
    validateApiKey: (key: string) =>
      valid.has(key)
        ? Promise.resolve({ id: key, role: ApiKeyRole.OPERATOR })
        : Promise.reject(new Error('Invalid API key')),
    hasPermission: () => true,
    createApiKey: (dto: { role: ApiKeyRole }) => {
      const rawKey = `owa_k1_minted_${minted.length + 1}`;
      minted.push(dto.role);
      valid.add(rawKey);
      return Promise.resolve({ apiKey: { id: rawKey }, rawKey });
    },
  });

  const runtime = (a = auth()) =>
    new AgentRuntime(
      { get: () => undefined } as never,
      a as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
      [],
    ) as unknown as {
      resolveAgentKey: (force?: boolean) => Promise<string | null>;
      invokeWithKeyRecovery: (tool: unknown, input: Record<string, unknown>, key: string) => Promise<unknown>;
    };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-key-'));
    process.env.BOOTSTRAP_KEY_FILE = join(dir, '.api-key');
    valid = new Set();
    minted = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.BOOTSTRAP_KEY_FILE;
    delete process.env.AGENT_API_KEY;
  });

  it('uses the configured key while it is valid, and mints nothing', async () => {
    process.env.AGENT_API_KEY = 'owa_k1_configured';
    valid.add('owa_k1_configured');

    expect(await runtime().resolveAgentKey()).toBe('owa_k1_configured');
    expect(minted).toEqual([]);
  });

  it('mints its own OPERATOR key when the configured one no longer exists — the live failure', async () => {
    process.env.AGENT_API_KEY = 'owa_k1_from_a_wiped_database';

    const key = await runtime().resolveAgentKey();

    expect(key).toBe('owa_k1_minted_1');
    // The lowest role the tools need; the sender's own role still narrows every call.
    expect(minted).toEqual([ApiKeyRole.OPERATOR]);
    const file = join(dir, '.agent-key');
    expect(readFileSync(file, 'utf-8').trim()).toBe('owa_k1_minted_1');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('mints one when nothing is configured at all', async () => {
    expect(await runtime().resolveAgentKey()).toBe('owa_k1_minted_1');
  });

  it('reuses the saved key after a restart instead of minting another', async () => {
    writeFileSync(join(dir, '.agent-key'), 'owa_k1_saved\n');
    valid.add('owa_k1_saved');

    expect(await runtime().resolveAgentKey()).toBe('owa_k1_saved');
    expect(minted).toEqual([]);
  });

  it('mints a single key when several messages arrive at once', async () => {
    const r = runtime();
    const keys = await Promise.all([r.resolveAgentKey(), r.resolveAgentKey(), r.resolveAgentKey()]);
    expect(new Set(keys).size).toBe(1);
    expect(minted).toHaveLength(1);
  });

  describe('a key refused mid-run', () => {
    let calls: string[];
    const tool = (fail?: string) =>
      defineTool({
        name: 'ProbeTool',
        description: 'probe',
        tier: 'read',
        requiredRole: ApiKeyRole.OPERATOR,
        inputSchema: z.object({}),
        handler: () => {
          calls.push('ran');
          return fail ? Promise.reject(new Error(fail)) : Promise.resolve({ ok: true });
        },
      });
    beforeEach(() => {
      calls = [];
    });

    it('re-provisions and retries once, so the person never sees "Invalid API key"', async () => {
      const r = runtime();
      // The cached key stops validating, as after a pepper change.
      const stale = await r.resolveAgentKey();
      valid.delete(stale as string);

      await expect(r.invokeWithKeyRecovery(tool(), {}, stale as string)).resolves.toEqual({ ok: true });
      expect(minted).toHaveLength(2);
      expect(calls).toEqual(['ran']);
    });

    it('does not retry a tool that failed on its own merits', async () => {
      const r = runtime();
      const key = (await r.resolveAgentKey()) as string;

      await expect(r.invokeWithKeyRecovery(tool('Document API responded 400'), {}, key)).rejects.toThrow(/400/);
      // Run once: a real failure must not run twice — it may have done something.
      expect(calls).toEqual(['ran']);
      expect(minted).toHaveLength(1);
    });
  });

  it('leaves no key file behind when minting is impossible', async () => {
    const a = { ...auth(), createApiKey: () => Promise.reject(new Error('database is read-only')) };
    expect(await runtime(a).resolveAgentKey()).toBeNull();
    expect(existsSync(join(dir, '.agent-key'))).toBe(false);
  });
});
