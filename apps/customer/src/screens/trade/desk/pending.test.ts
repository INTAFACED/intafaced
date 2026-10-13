import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isInFlight, markInFlight, pendingKey, readPending, release, reserve, unmarkInFlight } from './pending';

const USER = '00000000-0000-4000-8000-000000000001';
const marker = { kind: 'place' as const, symbol: 'BTC/USDT', id: 'desk:abc', startedAt: 1 };

function stubBrowser({ locks = true, lockHeld = false, failWrites = false } = {}) {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('blocked');
      store.set(key, value);
    },
    removeItem: (key: string) => void store.delete(key),
  };
  const events: string[] = [];
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { dispatchEvent: (event: Event) => events.push(event.type) });
  vi.stubGlobal(
    'navigator',
    locks
      ? {
          locks: {
            request: (_name: string, _options: unknown, callback: (lock: object | null) => unknown) => callback(lockHeld ? null : {}),
          },
        }
      : {},
  );
  return { store, events };
}

describe('the order marker', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('is written before an order is sent, with the old desk’s key and shape', async () => {
    const { store, events } = stubBrowser();
    expect(await reserve(USER, marker)).toBe('reserved');
    expect(JSON.parse(store.get(`trade-pending:${USER}`)!)).toEqual(marker);
    expect(pendingKey(USER)).toBe(`trade-pending:${USER}`);
    expect(events).toContain('trade-pending-change');
    expect(readPending(USER)).toEqual({ state: 'pending', value: marker });
  });

  it('refuses a second order while one is unconfirmed, and while the marker cannot be read', async () => {
    stubBrowser();
    expect(await reserve(USER, marker)).toBe('reserved');
    expect(await reserve(USER, { ...marker, id: 'desk:two' })).toBe('pending');
    const { store } = stubBrowser();
    store.set(`trade-pending:${USER}`, '{not json');
    expect(await reserve(USER, marker)).toBe('unreadable');
    store.set(`trade-pending:${USER}`, JSON.stringify({ kind: 'place' }));
    expect(await reserve(USER, marker)).toBe('unreadable');
  });

  it('refuses when another tab holds the slot, when locking is missing, and when the identity cannot be saved', async () => {
    stubBrowser({ lockHeld: true });
    expect(await reserve(USER, marker)).toBe('other-tab');
    stubBrowser({ locks: false });
    expect(await reserve(USER, marker)).toBe('no-locks');
    const { store } = stubBrowser({ failWrites: true });
    expect(await reserve(USER, marker)).toBe('no-storage');
    expect(store.size).toBe(0);
  });

  it('is released only by the order that wrote it', async () => {
    const { store } = stubBrowser();
    await reserve(USER, marker);
    release(USER, 'desk:someone-else');
    expect(store.has(`trade-pending:${USER}`)).toBe(true);
    release(USER, marker.id);
    expect(store.has(`trade-pending:${USER}`)).toBe(false);
    expect(readPending(USER)).toEqual({ state: 'none' });
  });

  it('tracks the orders this tab is sending, so the lookup waits for them', () => {
    expect(isInFlight('desk:abc')).toBe(false);
    markInFlight('desk:abc');
    expect(isInFlight('desk:abc')).toBe(true);
    unmarkInFlight('desk:abc');
    expect(isInFlight('desk:abc')).toBe(false);
  });
});
