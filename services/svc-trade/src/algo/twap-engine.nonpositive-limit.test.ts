import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
const LOT = parseAmount('0.001');
const MARKET = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
describe('L364 non-positive TWAP limit is refused (create throws or tick places nothing)', () => {
  it.each([0n, -5n])('limit %s', async (limit) => {
    const placed: string[] = [];
    const t = 1_700_000_000_000;
    const e = new TwapEngine({
      now: () => new Date(t),
      randomId: () => 'id-1',
      placeChild: async (r) => {
        placed.push(r.clientOrderId);
        return { orderId: 'o' };
      },
      cancelChild: async () => {},
      bestOpposingPrice: async () => parseAmount('50'),
      markFor: async (m) => ({ marketId: m, price: parseAmount('50'), asOf: new Date(t), quality: 'mid' as const }),
    } as TwapEnginePorts);
    try {
      const p = e.create(
        USER,
        {
          marketId: MARKET,
          symbol: 'BTC/USDT',
          side: 'sell',
          totalQty: parseAmount('0.010'),
          durationMs: 10_000,
          sliceIntervalMs: 2_000,
          limitPrice: limit,
          subAccountId: null,
          clientAlgoId: 'l364',
        } as never,
        LOT,
      );
      await e.tick(p.id);
    } catch {
      /* refusal at create is correct */
    }
    expect(placed).toEqual([]);
  });
});
