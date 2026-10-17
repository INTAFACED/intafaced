import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recheckCancel } from './cancel-recheck';
import { pendingKey, readPending, type Pending } from './write-lock';

const pending: Pending = { kind: 'cancel', symbol: 'BTC/USDT', id: 'cancel:o1', orderId: 'o1', startedAt: 1 };
const data = new Map<string, string>();

beforeEach(() => {
  data.clear();
  data.set(pendingKey('u1'), JSON.stringify(pending));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

const fake = (result: unknown) => {
  const order = vi.fn(async () => result as never);
  return { order };
};

describe('recheckCancel', () => {
  it('reads the order by id and symbol, clears the note when it finished', async () => {
    const api = fake({ ok: true, data: { status: 'canceled', recoveryRequired: false } });
    expect(await recheckCancel(api, 'u1', pending)).toEqual({ kind: 'done', status: 'canceled' });
    expect(api.order).toHaveBeenCalledWith({ id: 'o1', symbol: 'BTC/USDT' });
    expect(readPending('u1')).toEqual({ state: 'none' });
  });
  it('clears the note and says open when the order is still open', async () => {
    const api = fake({ ok: true, data: { status: 'open', recoveryRequired: false } });
    expect(await recheckCancel(api, 'u1', pending)).toEqual({ kind: 'open' });
    expect(readPending('u1').state).toBe('none');
  });
  it('keeps the note while the order is recovering, not found, or the read throws', async () => {
    expect(await recheckCancel(fake({ ok: true, data: { status: 'canceled', recoveryRequired: true } }), 'u1', pending)).toEqual({
      kind: 'checking',
    });
    expect(await recheckCancel(fake({ ok: false, reason: 'uncertain' }), 'u1', pending)).toEqual({ kind: 'unknown' });
    expect(await recheckCancel({ order: async () => Promise.reject(new Error('x')) }, 'u1', pending)).toEqual({ kind: 'unknown' });
    expect(readPending('u1').state).toBe('pending');
  });
  it('does nothing for a note that is not a cancel', async () => {
    const api = fake({ ok: true, data: { status: 'open', recoveryRequired: false } });
    expect(await recheckCancel(api, 'u1', { ...pending, kind: 'place' })).toEqual({ kind: 'unknown' });
    expect(api.order).not.toHaveBeenCalled();
  });
});
