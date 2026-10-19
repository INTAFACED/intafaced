import { expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TwapEngine, type TwapEnginePorts } from './twap-engine.js';
it.each(['', '   ', undefined])('L380 blank/missing clientAlgoId %j is refused (no random-id parent)', (id) => {
  const t = 1_700_000_000_000;
  const e = new TwapEngine({
    now: () => new Date(t),
    randomId: () => 'rand-' + Math.random(),
    placeChild: async () => ({ orderId: 'o' }),
    cancelChild: async () => {},
    bestOpposingPrice: async () => 50n,
    markFor: async (m: string) => ({ marketId: m, price: 50n, asOf: new Date(t), quality: 'mid' as const }),
  } as unknown as TwapEnginePorts);
  expect(() =>
    e.create(
      '22222222-2222-2222-2222-222222222222',
      {
        marketId: '11111111-1111-1111-1111-111111111111',
        symbol: 'BTC/USDT',
        side: 'buy',
        totalQty: parseAmount('0.010'),
        durationMs: 10_000,
        sliceIntervalMs: 2_000,
        limitPrice: null,
        subAccountId: null,
        clientAlgoId: id,
      } as never,
      parseAmount('0.001'),
    ),
  ).toThrow();
});
