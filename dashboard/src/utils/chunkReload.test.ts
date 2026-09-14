import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearChunkReloadGuard, loadChunkWithReload, CHUNK_RELOAD_KEY } from './chunkReload.ts';

function makeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: k => void m.delete(k),
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('returns the module and clears the reload flag on success', async () => {
  const storage = makeStorage({ owa_chunk_reloaded: '1' });
  const mod = { default: 'Component' };
  let reloads = 0;

  const result = await loadChunkWithReload(() => Promise.resolve(mod), { reload: () => reloads++, storage });

  assert.equal(result, mod);
  assert.equal(reloads, 0);
  assert.equal(storage.getItem('owa_chunk_reloaded'), null);
});

test('reloads exactly once on a chunk failure when no reload has happened yet', async () => {
  const storage = makeStorage();
  let reloads = 0;

  // The result never settles (Suspense holds until the reload), so don't await it.
  void loadChunkWithReload(() => Promise.reject(new Error('Loading chunk 7 failed')), {
    reload: () => reloads++,
    storage,
  });
  await flush();

  assert.equal(reloads, 1);
  assert.equal(storage.getItem('owa_chunk_reloaded'), '1');
});

test('rethrows instead of reloading again once a reload already happened (no loop)', async () => {
  const storage = makeStorage({ owa_chunk_reloaded: '1' });
  let reloads = 0;

  await assert.rejects(
    loadChunkWithReload(() => Promise.reject(new Error('still failing')), { reload: () => reloads++, storage }),
    /still failing/,
  );
  assert.equal(reloads, 0);
});

test('clearing the guard re-arms the one-shot reload, so a recovery button can actually recover', async () => {
  // The bug this pins: the guard survives a manual reload, so a "Reload" button that does not clear
  // it lands straight back on the error screen — the failure looks permanent instead of recoverable.
  const storage = makeStorage({ [CHUNK_RELOAD_KEY]: '1' });
  let reloads = 0;

  // With the guard set, the helper refuses to retry.
  await assert.rejects(
    loadChunkWithReload(() => Promise.reject(new Error('stale chunk')), { reload: () => reloads++, storage }),
    /stale chunk/,
  );
  assert.equal(reloads, 0);

  clearChunkReloadGuard(storage);
  assert.equal(storage.getItem(CHUNK_RELOAD_KEY), null);

  // Re-armed: the next failure self-heals with a reload again.
  void loadChunkWithReload(() => Promise.reject(new Error('stale chunk')), { reload: () => reloads++, storage });
  await flush();
  assert.equal(reloads, 1);
});

test('clearing the guard never throws when storage is unavailable', () => {
  // Site data can be blocked, in which case touching sessionStorage throws — and the reload that
  // follows this call still has to happen.
  const hostile = {
    removeItem() {
      throw new Error('access denied');
    },
  };
  assert.doesNotThrow(() => clearChunkReloadGuard(hostile));
});
