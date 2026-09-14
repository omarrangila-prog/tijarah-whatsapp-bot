// Recovery for a failed dynamic import() of a route/lazy chunk. The dominant cause is a redeploy:
// the running index.html references hashed chunk filenames that no longer exist on the server, so
// import() rejects. A one-time full reload pulls the fresh index + chunks. A sessionStorage flag
// guards against a reload loop when the failure is not deploy-related (adblock, offline, real 404).
// React-free on purpose so it is unit-testable without a DOM. See lazyWithRetry.ts for the wiring.

/**
 * Session flag marking that a reload has already been attempted for a failed chunk load.
 *
 * Exported because the top-level ErrorBoundary must be able to CLEAR it: once the flag is set, this
 * helper stops retrying and lets the error surface — so a "Reload" button that does not clear it
 * reloads into the very same failure and shows the error page again, forever. That was the bug.
 */
export const CHUNK_RELOAD_KEY = 'owa_chunk_reloaded';

/** Clear the one-shot guard so the next chunk failure is allowed to self-heal with a reload. */
export function clearChunkReloadGuard(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // A browser with site data blocked throws on storage access. Nothing to clear in that case,
    // and the reload must still happen — so this must never propagate.
  }
}

const RELOAD_KEY = CHUNK_RELOAD_KEY;

export interface ChunkReloadDeps {
  reload: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export async function loadChunkWithReload<T>(factory: () => Promise<T>, deps: ChunkReloadDeps): Promise<T> {
  try {
    const mod = await factory();
    deps.storage.removeItem(RELOAD_KEY);
    return mod;
  } catch (err) {
    if (!deps.storage.getItem(RELOAD_KEY)) {
      deps.storage.setItem(RELOAD_KEY, '1');
      deps.reload();
      // Hold Suspense until the reload navigates away; never resolve/reject this load.
      return new Promise<T>(() => {});
    }
    // A reload already happened and it still failed → let the caller's error boundary surface it.
    throw err;
  }
}
