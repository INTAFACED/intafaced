import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPending, pendingKey, readPending, runGuarded, type Pending } from './write-lock';

function memoryStorage(initial: Record<string, string> = {}, failWrites = false) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('quota');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
}

const pending: Pending = { kind: 'place', symbol: 'BTC/USDT', id: 'buy:1', startedAt: 1 };
const fakeLocks = (grant = true) => ({
  request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) =>
    callback(grant ? { name: 'lock' } : null),
});

let storage: ReturnType<typeof memoryStorage>;
function install(next: ReturnType<typeof memoryStorage>, locks: unknown = fakeLocks()) {
  storage = next;
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { locks });
}

beforeEach(() => install(memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('the shared device note', () => {
  it('uses the same key and shape as the old desk', () => {
    expect(pendingKey('u1')).toBe('trade-pending:u1');
    install(memoryStorage({ 'trade-pending:u1': JSON.stringify({ kind: 'place', symbol: 'BTC/USDT', id: 'desk:9', startedAt: 5 }) }));
    expect(readPending('u1')).toEqual({ state: 'pending', pending: { kind: 'place', symbol: 'BTC/USDT', id: 'desk:9', startedAt: 5 } });
  });

  it('treats an unreadable note as a blocker, never as nothing pending', () => {
    install(memoryStorage({ 'trade-pending:u1': '{nope' }));
    expect(readPending('u1')).toEqual({ state: 'unreadable' });
    install(memoryStorage({ 'trade-pending:u1': JSON.stringify({ kind: 'weird' }) }));
    expect(readPending('u1')).toEqual({ state: 'unreadable' });
    expect(readPending(null)).toEqual({ state: 'none' });
  });

  it('only clears its own note', () => {
    runGuarded(
      'u1',
      pending,
      async () => 'x',
      () => true,
    );
    expect(clearPending('u1', 'someone-else')).toBe(false);
  });
});

describe('runGuarded', () => {
  it('writes the note, runs once, and removes the note when the outcome is known', async () => {
    const call = vi.fn(async () => 'done');
    const outcome = await runGuarded('u1', pending, call, () => false);
    expect(outcome).toEqual({ kind: 'ran', value: 'done' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(storage.data.has('trade-pending:u1')).toBe(false);
  });

  it('keeps the note when the outcome is unknown, so nothing else goes out', async () => {
    const outcome = await runGuarded(
      'u1',
      pending,
      async () => 'unknown',
      () => true,
    );
    expect(outcome).toEqual({ kind: 'ran', value: 'unknown' });
    expect(storage.data.has('trade-pending:u1')).toBe(true);
    const call = vi.fn(async () => 'second');
    const second = await runGuarded('u1', { ...pending, id: 'buy:2' }, call, () => false);
    expect(second).toMatchObject({ kind: 'blocked', reason: 'pending', pending: { id: 'buy:1' } });
    expect(call).not.toHaveBeenCalled();
  });

  it('lets only the SAME request run again over its own note (a button the customer pressed)', async () => {
    await runGuarded(
      'u1',
      pending,
      async () => 'unknown',
      () => true,
    );
    const call = vi.fn(async () => 'now known');
    expect(await runGuarded('u1', pending, call, () => false)).toMatchObject({ kind: 'blocked', reason: 'pending' });
    expect(await runGuarded('u1', pending, call, () => false, { recheck: true })).toEqual({ kind: 'ran', value: 'now known' });
    expect(storage.data.has('trade-pending:u1')).toBe(false);
  });

  it('sends nothing when the note cannot be saved', async () => {
    install(memoryStorage({}, true));
    const call = vi.fn(async () => 'x');
    expect(await runGuarded('u1', pending, call, () => false)).toEqual({ kind: 'blocked', reason: 'storage' });
    expect(call).not.toHaveBeenCalled();
  });

  it('sends nothing when another tab holds the lock, when locks do not exist, or when signed out', async () => {
    const call = vi.fn(async () => 'x');
    install(memoryStorage(), fakeLocks(false));
    expect(await runGuarded('u1', pending, call, () => false)).toEqual({ kind: 'blocked', reason: 'otherTab' });
    install(memoryStorage(), null);
    expect(await runGuarded('u1', pending, call, () => false)).toEqual({ kind: 'blocked', reason: 'noLocks' });
    install(memoryStorage());
    expect(await runGuarded(null, pending, call, () => false)).toEqual({ kind: 'blocked', reason: 'signedOut' });
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps the note if the call throws, and never calls twice', async () => {
    const call = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await runGuarded('u1', pending, call, () => false)).toEqual({ kind: 'threw' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(storage.data.has('trade-pending:u1')).toBe(true);
  });
});
