import { describe, expect, it } from 'vitest';
import { clearScaleMarker, readScaleMarker, scaleMarkerKey, writeScaleMarker, type ScaleMarker } from './scale-marker';

class Store {
  data = new Map<string, string>();
  getItem = (key: string) => this.data.get(key) ?? null;
  setItem = (key: string, value: string) => void this.data.set(key, value);
  removeItem = (key: string) => void this.data.delete(key);
}
const draft = (n: number) => ({
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  amount: '0.0002',
  price: String(100 + n),
  timeInForce: 'GTC' as const,
  postOnly: false,
  clientOrderId: `desk:scale:b:${n}`,
});
const marker: ScaleMarker = { batchId: 'b', symbol: 'BTC/USDT', startedAt: 1, drafts: [draft(0), draft(1)] };

describe('scale marker', () => {
  it('round-trips the exact orders', () => {
    const store = new Store();
    expect(readScaleMarker('u1', store)).toEqual({ state: 'none' });
    expect(writeScaleMarker('u1', marker, store)).toBe(true);
    expect(readScaleMarker('u1', store)).toEqual({ state: 'pending', value: marker });
    expect(store.data.has(scaleMarkerKey('u1'))).toBe(true);
  });

  it('is per user', () => {
    const store = new Store();
    writeScaleMarker('u1', marker, store);
    expect(readScaleMarker('u2', store)).toEqual({ state: 'none' });
  });

  it('is cleared when every order is known', () => {
    const store = new Store();
    writeScaleMarker('u1', marker, store);
    clearScaleMarker('u1', store);
    expect(readScaleMarker('u1', store)).toEqual({ state: 'none' });
  });

  it('a marker that cannot be read is reported, never treated as empty', () => {
    const store = new Store();
    store.setItem(scaleMarkerKey('u1'), '{"nonsense":true}');
    expect(readScaleMarker('u1', store)).toEqual({ state: 'unreadable' });
    store.setItem(scaleMarkerKey('u1'), 'not json');
    expect(readScaleMarker('u1', store)).toEqual({ state: 'unreadable' });
  });

  it('reports false when the browser cannot store it, so the batch is not sent', () => {
    const broken = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(writeScaleMarker('u1', marker, broken)).toBe(false);
  });
});
