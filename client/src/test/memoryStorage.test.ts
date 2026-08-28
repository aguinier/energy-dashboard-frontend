import { describe, it, expect } from 'vitest';
import {
  createMemoryStorage,
  installMemoryStorage,
  isUsableStorage,
} from './memoryStorage';

/**
 * The exact shape Node 25 puts on `globalThis` when the Web Storage API is on
 * but `--localstorage-file` was not passed: an object, with keys, that answers
 * `typeof x === 'object'` — and no methods. This is what made ABL-320's failure
 * a `TypeError` rather than a clean ReferenceError, and what makes presence
 * checks the wrong discriminator.
 */
const NODE_25_STUB = {} as unknown;

describe('createMemoryStorage', () => {
  it('round-trips a value', () => {
    const storage = createMemoryStorage();
    storage.setItem('k', 'v');
    expect(storage.getItem('k')).toBe('v');
  });

  it('returns null — not undefined — for a key that was never set', () => {
    expect(createMemoryStorage().getItem('absent')).toBeNull();
  });

  it('returns null for a key that was removed', () => {
    const storage = createMemoryStorage();
    storage.setItem('k', 'v');
    storage.removeItem('k');
    expect(storage.getItem('k')).toBeNull();
  });

  it('stringifies values, as Web Storage does', () => {
    const storage = createMemoryStorage();
    storage.setItem('n', 42 as unknown as string);
    expect(storage.getItem('n')).toBe('42');
  });

  it('tracks length across writes, overwrites and removals', () => {
    const storage = createMemoryStorage();
    expect(storage.length).toBe(0);
    storage.setItem('a', '1');
    storage.setItem('b', '2');
    expect(storage.length).toBe(2);
    storage.setItem('a', '3');
    expect(storage.length).toBe(2);
    storage.removeItem('b');
    expect(storage.length).toBe(1);
  });

  it('clears every entry', () => {
    const storage = createMemoryStorage();
    storage.setItem('a', '1');
    storage.setItem('b', '2');
    storage.clear();
    expect(storage.length).toBe(0);
    expect(storage.getItem('a')).toBeNull();
  });

  it('indexes keys in insertion order and returns null out of range', () => {
    const storage = createMemoryStorage();
    storage.setItem('a', '1');
    storage.setItem('b', '2');
    expect(storage.key(0)).toBe('a');
    expect(storage.key(1)).toBe('b');
    expect(storage.key(2)).toBeNull();
    expect(storage.key(-1)).toBeNull();
  });

  it('hands out isolated instances', () => {
    const one = createMemoryStorage();
    const two = createMemoryStorage();
    one.setItem('k', 'v');
    expect(two.getItem('k')).toBeNull();
  });
});

describe('isUsableStorage', () => {
  it('accepts a complete Storage', () => {
    expect(isUsableStorage(createMemoryStorage())).toBe(true);
  });

  it('rejects the Node 25 stub, which is present but has no methods', () => {
    expect(isUsableStorage(NODE_25_STUB)).toBe(false);
  });

  it('rejects a partial Storage missing only setItem — the ABL-320 failure', () => {
    expect(isUsableStorage({
      getItem: () => null,
      removeItem: () => {},
      clear: () => {},
      key: () => null,
    })).toBe(false);
  });

  it('rejects absence', () => {
    expect(isUsableStorage(undefined)).toBe(false);
    expect(isUsableStorage(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isUsableStorage('localStorage')).toBe(false);
  });
});

describe('installMemoryStorage', () => {
  it('installs onto a target with no localStorage at all (Node 24 and earlier)', () => {
    const target: Record<string, unknown> = {};
    expect(installMemoryStorage(target)).toBe('installed');
    expect(isUsableStorage(target.localStorage)).toBe(true);
  });

  it('replaces a present-but-broken localStorage (Node 25)', () => {
    const target: Record<string, unknown> = { localStorage: NODE_25_STUB };
    expect(installMemoryStorage(target)).toBe('installed');
    expect(isUsableStorage(target.localStorage)).toBe(true);
  });

  it('replaces one defined as a configurable accessor, which is how Node 25 defines it', () => {
    const target: Record<string, unknown> = {};
    Object.defineProperty(target, 'localStorage', {
      get: () => NODE_25_STUB,
      configurable: true,
    });

    expect(installMemoryStorage(target)).toBe('installed');
    expect(isUsableStorage(target.localStorage)).toBe(true);
  });

  it('leaves a working Storage alone rather than clobbering a real browser one', () => {
    const existing = createMemoryStorage();
    existing.setItem('keep', 'me');
    const target: Record<string, unknown> = { localStorage: existing };

    expect(installMemoryStorage(target)).toBe('kept-existing');
    expect(target.localStorage).toBe(existing);
    expect(existing.getItem('keep')).toBe('me');
  });
});

/**
 * The regression guard proper. Everything above tests the helper in isolation
 * and would still pass if `setup.ts` were dropped from `vite.config.ts`; this
 * asserts the wiring, in the same ambient environment every other test file
 * gets. If this fails, `dashboardStore.test.ts` and `windowLabel.test.ts` are
 * about to fail with `storage.setItem is not a function`.
 */
describe('the ambient environment every test file runs in', () => {
  it('has a localStorage a persisted zustand store can write through', () => {
    expect(isUsableStorage(globalThis.localStorage)).toBe(true);

    globalThis.localStorage.setItem('abl-320-probe', 'written');
    expect(globalThis.localStorage.getItem('abl-320-probe')).toBe('written');
    globalThis.localStorage.removeItem('abl-320-probe');
  });
});
