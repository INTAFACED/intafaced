import { describe, expect, it } from 'vitest';
import { depositRoute, routeOf } from './move-route';

const route = {
  chainId: 84532,
  token: '0x1111111111111111111111111111111111111111',
  tokenDecimals: 6,
  address: '0x2222222222222222222222222222222222222222',
  asset: 'USDC',
};
const up = { enabled: true, available: true, deposit: route };
const down = { enabled: true, available: false };

describe('the deposit route a move sends to', () => {
  it('is the status route only when the door is on and the venue is up', () => {
    expect(routeOf(up)).toEqual(route);
    expect(routeOf(down)).toBeNull();
    expect(routeOf({ enabled: false })).toBeNull();
    expect(routeOf({ enabled: true, available: true, deposit: null })).toBeNull();
    expect(routeOf(null)).toBeNull();
  });

  // J-derivatives-25 #2 on main (run 44987186342): the room's first status read came while the venue was not up yet,
  // so the polled route was null when the partner leg finished, and the move was refused "publishes no deposit address".
  it('reads the venue again when the deposit starts, so a stale polled read never refuses a move the venue takes', async () => {
    expect(await depositRoute(null, async () => ({ ok: true, data: up }))).toEqual(route);
  });

  it('refuses when the fresh read names no route, whatever the polled read said', async () => {
    expect(await depositRoute(route, async () => ({ ok: true, data: down }))).toBeNull();
  });

  it('keeps the polled route when the fresh read fails or throws', async () => {
    expect(await depositRoute(route, async () => ({ ok: false }))).toEqual(route);
    expect(await depositRoute(route, () => Promise.reject(new Error('offline')))).toEqual(route);
    expect(await depositRoute(null, async () => ({ ok: false }))).toBeNull();
  });
});
