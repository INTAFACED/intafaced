import { describe, expect, it } from 'vitest';
import { LEDGER_POST_ALLOWLIST, grantFor, modulesFor } from './caller-allowlist.js';

describe('svc-market ledger grant', () => {
  it('may post the sale and the three held-purchase recipes in the market module, and nothing else', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-market']).toEqual({
      marketPurchase: { module: 'market', cite: 'services/svc-market/src/commerce/commerce-service.ts' },
      marketPurchaseHold: { module: 'market', cite: 'services/svc-market/src/commerce/held-purchase.ts' },
      marketPurchaseRefund: { module: 'market', cite: 'services/svc-market/src/commerce/held-purchase.ts' },
      marketPurchaseRelease: { module: 'market', cite: 'services/svc-market/src/commerce/held-purchase.ts' },
    });
    expect(grantFor('svc-market', 'marketListingFee')).toBeUndefined();
    expect(grantFor('svc-market', 'marketPremiumPlacement')).toBeUndefined();
    expect(grantFor('svc-market', 'rewardPay')).toBeUndefined();
    expect([...modulesFor('svc-market')]).toEqual(['market']);
  });
});
