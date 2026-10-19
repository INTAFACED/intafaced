import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
const LOT = parseAmount('0.001');
const MARKET = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
function ports(opp: bigint, placed: string[]): TwapEnginePorts {
  const t = 1_700_000_000_000;
  return {
    now: () => new Date(t),
    randomId: () => 'id-1',
    placeChild: async (r) => {
      placed.push(r.clientOrderId);
      return { orderId: 'o' };
    },
    cancelChild: async () => {},
    bestOpposingPrice: async () => opp,
    markFor: async (m) => ({ marketId: m, price: parseAmount('50'), asOf: new Date(t), quality: 'mid' as const }),
  } as TwapEnginePorts;
}
describe('L363 non-positive opposing price is not liquidity', () => {
  it.each([0n, -5n])('opposing %s places no child', async (opp) => {
    const placed: string[] = [];
    const e = new TwapEngine(ports(opp, placed));
    const p = e.create(
      USER,
      {
        marketId: MARKET,
        symbol: 'BTC/USDT',
        side: 'sell',
        totalQty: parseAmount('0.010'),
        durationMs: 10_000,
        sliceIntervalMs: 2_000,
        limitPrice: null,
        subAccountId: null,
        clientAlgoId: 'l363',
      } as never,
      LOT,
    );
    await e.tick(p.id);
    expect(placed).toEqual([]);
  });
});
