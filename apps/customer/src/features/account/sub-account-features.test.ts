import { describe, expect, it } from 'vitest';
import { subAccountFeaturesMessages } from './sub-account-features-copy';
import { FEATURES, FEATURE_REFUSAL_KEYS, assetsView, featureResult, featuresView } from './sub-account-features';

describe('sub-account features', () => {
  it('has a sentence for every feature and every refusal the card can show', () => {
    for (const key of [...FEATURES.map((f) => `feature_${f}`), ...Object.values(FEATURE_REFUSAL_KEYS)]) {
      expect(Object.hasOwn(subAccountFeaturesMessages, key), key).toBe(true);
    }
  });

  it('reads the answers strictly', () => {
    const view = { kind: 'standard', frozen: false, published: true, features: [{ feature: 'spot', offered: true, enabled: false }] };
    expect(featuresView.safeParse(view).success).toBe(true);
    expect(featuresView.safeParse({ ...view, features: [{ feature: 'margin', offered: true, enabled: false }] }).success).toBe(false);
    expect(featureResult.safeParse({ feature: 'spot', enabled: true, changed: true }).success).toBe(true);
    expect(assetsView.safeParse({ balances: [{ assetId: 'USDT', amount: '1.50' }] }).success).toBe(true);
    expect(assetsView.safeParse({}).success).toBe(false);
  });
});
