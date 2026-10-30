import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt, recipes, type PostRequest } from '@intafaced/ledger-client';
import { grantFor } from './caller-allowlist.js';
import { judgeCallerPost } from './caller-binding.js';

const MAKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function toWire(req: PostRequest) {
  return {
    idempotencyKey: req.idempotencyKey,
    module: req.module,
    reason: req.reason,
    ...(req.meta ? { meta: req.meta } : {}),
    entries: req.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
  };
}

/** TEST amounts only. */
const BUYBACK = [
  ['buybackOrderHold', toWire(recipes.buybackOrderHold({ orderId: 'bb-grant', quoteAsset: 'USDT', amount: amt('10') }))],
  [
    'buybackOrderHoldRelease',
    toWire(recipes.buybackOrderHoldRelease({ orderId: 'bb-grant', quoteAsset: 'USDT', amount: amt('10'), sequence: 0 })),
  ],
  [
    'buybackTakerFill',
    toWire(
      recipes.buybackTakerFill({
        fillId: 'bb-grant-fill',
        makerId: MAKER,
        makerOrderId: 'bb-grant-ask',
        takerOrderId: 'bb-grant',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('10'),
        makerFeeBps: 0,
      }),
    ),
  ],
] as const;

describe('svc-trade token buyback ledger grant', () => {
  it('grants the three buyback recipes to svc-trade in the trade module, at the files that post them', () => {
    expect(grantFor('svc-trade', 'buybackOrderHold')).toEqual({
      module: 'trade',
      cite: 'services/svc-trade/src/spot/trade-service/buyback.ts',
    });
    expect(grantFor('svc-trade', 'buybackOrderHoldRelease')).toEqual({
      module: 'trade',
      cite: 'services/svc-trade/src/spot/buyback-order.ts',
    });
    expect(grantFor('svc-trade', 'buybackTakerFill')).toEqual({
      module: 'trade',
      cite: 'services/svc-trade/src/spot/trade-service/fills.ts',
    });
  });

  it('grants them to no other service', () => {
    for (const service of ['svc-token', 'svc-pay', 'svc-bank', 'svc-campaigns', 'svc-mining-pool', 'svc-ops']) {
      for (const [recipe] of BUYBACK) expect(grantFor(service, recipe), `${service} ${recipe}`).toBeUndefined();
    }
  });

  it.each(BUYBACK)('a key-proven svc-trade may post %s', (recipe, body) => {
    expect(judgeCallerPost({ kind: 'bound', service: 'svc-trade' }, body)).toEqual({ ok: true, recipe });
  });

  it.each(BUYBACK)('a key-proven svc-token or svc-pay may not post %s', (recipe, body) => {
    for (const service of ['svc-token', 'svc-pay']) {
      const judged = judgeCallerPost({ kind: 'bound', service }, body);
      expect(judged.ok, service).toBe(false);
      if (!judged.ok) expect(judged.violation, service).toMatchObject({ code: 'ledger.caller_forbidden', service, recipe });
    }
  });
});
