/**
 * Unit card — price-alert fire keys are real catalog entries
 * 1. Promise: alerts/service fireNotification uses notify.alert.price.crossed.*
 * 2. Break: missing keys → out-of-app body is the greppable key string (W5 park)
 * 3. Done bar: both keys exist in @intafaced/i18n MESSAGE_KEYS / catalog
 * 4. Class N
 * 5. Paths: packages/i18n + services/svc-notify (one residual; i18n was free)
 * 6. RED pin
 * 7. Collision: claim-check packages/i18n before push
 */

import { describe, expect, it } from 'vitest';
import { MESSAGE_KEYS, createTranslator } from '@intafaced/i18n';

const KEYS = [
  ['notify.alert.price.crossed.title', 'notify.alert.price.crossed.body'],
  ['notify.alert.funding.crossed.title', 'notify.alert.funding.crossed.body'],
  ['notify.alert.liquidation_proximity.crossed.title', 'notify.alert.liquidation_proximity.crossed.body'],
  ['notify.alert.whale.crossed.title', 'notify.alert.whale.crossed.body'],
  // The person's own name and message (C-alerts-scan-01).
  ['notify.alert.price.crossed.named.title', 'notify.alert.price.crossed.message.body'],
] as const;

describe('v22.alerts catalog keys pin', () => {
  it('title and body keys are in the English catalog', () => {
    for (const [title, body] of KEYS) {
      expect(MESSAGE_KEYS).toContain(title);
      expect(MESSAGE_KEYS).toContain(body);
    }
  });

  it('renders human copy, not the key string', () => {
    const t = createTranslator('en');
    const params = {
      marketId: 'BTC-PERP',
      direction: 'above',
      targetPrice: '100000',
      markPrice: '100500',
    };
    const priceTitle = t.t('notify.alert.price.crossed.title');
    const priceBody = t.t('notify.alert.price.crossed.body', params);
    expect(priceTitle).not.toBe('notify.alert.price.crossed.title');
    expect(priceBody).not.toBe('notify.alert.price.crossed.body');
    expect(priceBody).toMatch(/BTC-PERP/);
    expect(priceBody).toMatch(/100000/);

    const funding = t.t('notify.alert.funding.crossed.body', params);
    expect(funding).toMatch(/Funding watch/);
    expect(funding).toMatch(/BTC-PERP/);

    const liq = t.t('notify.alert.liquidation_proximity.crossed.body', params);
    expect(liq).toMatch(/Liquidation-proximity/);
    expect(liq).toMatch(/100500/);

    const whale = t.t('notify.alert.whale.crossed.body', params);
    expect(whale).toMatch(/Whale-flow/);
    expect(whale).toMatch(/BTC-PERP/);
    expect(whale).not.toMatch(/notify\.alert\.whale/);

    // A named alert shows the person's own words, not the stock sentence and not a key string.
    expect(t.t('notify.alert.price.crossed.named.title', { name: 'Breakout' })).toBe('Breakout');
    expect(t.t('notify.alert.price.crossed.message.body', { message: 'BTC-USD hit 101' })).toBe('BTC-USD hit 101');
  });
});
