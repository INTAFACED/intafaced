import { describe, expect, it } from 'vitest';
import { LEDGER_POST_ALLOWLIST, grantFor, modulesFor } from './caller-allowlist.js';

describe('svc-market ledger grant (MC-market-02, J-more-catalogue-02 #4 to #6)', () => {
  it('may post a pay-through purchase and the held purchase recipes in the market module, and nothing else', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-market']).toEqual({
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
