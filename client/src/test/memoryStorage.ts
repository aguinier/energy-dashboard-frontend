/**
 * A spec-shaped in-memory Web Storage, plus the guard that installs it when the
 * host does not offer a usable one.
 *
 * `dashboardStore` is a zustand **persisted** store. The persist middleware
 * resolves the bare global `localStorage` exactly once — at module-import
 * time — and then calls `storage.setItem` on every `setState`. What that bare
 * global resolves to under vitest depends on the Node major, and *both*
 * outcomes are wrong for a test run (ABL-320):
 *
 * - **Node 24 and earlier** define no `localStorage` at all. Zustand's
 *   `createJSONStorage` catches the ReferenceError and returns `undefined`, so
 *   persist silently degrades to a no-op. The suite is green, but nothing about
 *   persistence — `partialize`, `version`, `migratePersisted` — is exercised.
 * - **Node 25** ships the Web Storage API on by default, so `localStorage` is
 *   an object; but without `--localstorage-file` it carries no `setItem`.
 *   `createJSONStorage` does not throw, hands back a wrapper, and every
 *   `setState` dies with `TypeError: storage.setItem is not a function` —
 *   20 failures across `dashboardStore.test.ts` and `windowLabel.test.ts`.
 *
 * A jsdom environment does not rescue either case. Vitest aliases `window` to
 * `globalThis`, and Node's own global wins over jsdom's, so under
 * `@vitest-environment jsdom` on Node 25.6.1 + jsdom 30,
 * `window.localStorage === globalThis.localStorage` and `setItem` is still
 * `undefined`. Measured, not assumed — `environment: 'jsdom'` alone leaves all
 * 20 failures in place, which is why the fix is a setup file rather than an
 * environment switch.
 *
 * So the suite stops depending on the ambient global and installs a real
 * Storage of its own. Wired from `client/vite.config.ts` via
 * `test.setupFiles` -> `./src/test/setup.ts`.
 */

/**
 * The members zustand's persist middleware and our own tests actually call.
 * `length` is a getter rather than a method, so it is deliberately not here.
 */
const STORAGE_METHODS = ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const;

/**
 * The slice of the Web Storage API we implement. Narrower than the DOM's
 * `Storage`, which carries an arbitrary string index signature that a plain
 * object literal cannot satisfy without weakening every call site.
 */
export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * Whether `candidate` can actually back a persisted store.
 *
 * Presence is not the test — Node 25's stub *is* an object and *does* answer
 * `typeof localStorage === 'object'`. Only the callable members discriminate it
 * from a working Storage.
 */
export function isUsableStorage(candidate: unknown): candidate is MemoryStorage {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const storage = candidate as Record<string, unknown>;
  return STORAGE_METHODS.every((method) => typeof storage[method] === 'function');
}

/** A fresh, isolated Storage backed by a Map. */
export function createMemoryStorage(): MemoryStorage {
  const entries = new Map<string, string>();

  return {
    getItem: (key) => entries.get(String(key)) ?? null,
    setItem: (key, value) => {
      // Web Storage stringifies both sides; a test that writes a number and
      // reads a number back would pass here and fail in a browser.
      entries.set(String(key), String(value));
    },
    removeItem: (key) => {
      entries.delete(String(key));
    },
    clear: () => {
      entries.clear();
    },
    key: (index) => {
      const keys = Array.from(entries.keys());
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    get length() {
      return entries.size;
    },
  };
}

export type StorageInstallResult = 'installed' | 'kept-existing';

/**
 * Give `target` a working `localStorage`, unless it already has one.
 *
 * A real Storage (a browser, or a jsdom environment that managed to put its own
 * on the global) is left alone; a missing one and a non-functional one are both
 * replaced. `configurable: true` matters — Node 25 defines `localStorage` as a
 * configurable accessor, so this has to redefine the property rather than
 * assign through it.
 */
export function installMemoryStorage(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): StorageInstallResult {
  if (isUsableStorage(target.localStorage)) return 'kept-existing';

  Object.defineProperty(target, 'localStorage', {
    value: createMemoryStorage(),
    writable: true,
    configurable: true,
  });
  return 'installed';
}
