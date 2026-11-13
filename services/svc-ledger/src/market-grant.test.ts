import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt, recipes, type PostRequest } from '@intafaced/ledger-client';
import { LEDGER_POST_ALLOWLIST, grantFor, modulesFor } from './caller-allowlist.js';
import { judgeCallerPost } from './caller-binding.js';
import { assertKnownRecipePost, recipeCandidates } from './recipe-gate.js';

describe('svc-market ledger grant (MC-market-02, J-more-catalogue-02 #4 to #6)', () => {
  it('may post a pay-through purchase, the held purchase recipes and a card-paid signal charge in the market module, and nothing else', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-market']).toEqual({
      chargeEarn: { module: 'market', cite: 'services/svc-market/src/signals/signal-market.ts' },
      chargeCollect: { module: 'market', cite: 'services/svc-market/src/signals/signal-market.ts' },
      marketPurchase: { module: 'market', cite: 'services/svc-market/src/commerce/commerce-service.ts' },
      marketPurchaseHold: { module: 'market', cite: 'services/svc-market/src/commerce/held-purchase.ts' },
      marketPurchaseRefund: { module: 'market', cite: 'services/svc-market/src/commerce/held-purchase.ts' },
      marketPurchaseRelease: { module: 'market', cite: 'services/svc-market/src/commerce/held-purchase.ts' },
    });
    expect(grantFor('svc-market', 'marketPurchaseRelease')?.module).toBe('market');
    expect(grantFor('svc-market', 'deposit')).toBeUndefined();
    expect(grantFor('svc-market', 'rewardPay')).toBeUndefined();
    expect([...modulesFor('svc-market')]).toEqual(['market']);
  });
});

describe('svc-market signal charge posts pass the ledger door (J-copy-bots-otc-21 #2)', () => {
  const U = '11111111-1111-4111-8111-111111111111';
  const toWire = (post: PostRequest) => ({
    idempotencyKey: post.idempotencyKey,
    module: post.module,
    reason: post.reason,
    ...(post.meta ? { meta: post.meta } : {}),
    entries: post.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
  });
  const earn = toWire(
    recipes.chargeEarn({
      module: 'market',
      saleId: 'a1b2c3d4-0000-4000-8000-000000000001',
      userId: U,
      assetId: 'USDC',
      price: { perUnit: amt('5') },
      units: 1n,
    }),
  );
  const collect = toWire(
    recipes.chargeCollect({
      module: 'market',
      userId: U,
      to: { kind: 'partner-reserve', partnerId: 'test-card' },
      paymentId: 'test-settle-0123456789abcdef',
      assetId: 'USDC',
      amount: amt('5'),
    }),
  );

  it('the recipe gate knows both as recipes in the market module', () => {
    expect(() => assertKnownRecipePost(earn)).not.toThrow();
    expect(() => assertKnownRecipePost(collect)).not.toThrow();
    expect(recipeCandidates(earn)).toEqual(['chargeEarn']);
    expect(recipeCandidates(collect)).toEqual(['chargeCollect']);
  });

  it('svc-market, by its own key, may post both; another service may not', () => {
    const market = { kind: 'bound', service: 'svc-market' } as const;
    expect(judgeCallerPost(market, earn)).toEqual({ ok: true, recipe: 'chargeEarn' });
    expect(judgeCallerPost(market, collect)).toEqual({ ok: true, recipe: 'chargeCollect' });
    expect(judgeCallerPost({ kind: 'bound', service: 'svc-trade' }, earn).ok).toBe(false);
  });
});
