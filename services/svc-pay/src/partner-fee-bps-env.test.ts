import { describe, expect, it } from 'vitest';
import { parsePartnerFeeBpsEnv } from './fee-bps-env.js';

/**
 * `PAY_PARTNER_FEE_BPS` is our fee rate in each partner's contract (launch money model). Blank is no partner at all, never
 * 0, and a value that does not read refuses whole: a typo must not leave a partner unset or book a fee nobody agreed.
 */
describe('PAY_PARTNER_FEE_BPS', () => {
  it('blank or unset sets no partner, so every partner payment refuses', () => {
    expect(parsePartnerFeeBpsEnv(undefined)).toEqual({});
    expect(parsePartnerFeeBpsEnv('  ')).toEqual({});
  });

  it('reads each partner’s rate, an explicit 0 included', () => {
    expect(parsePartnerFeeBpsEnv('bank-transfer-sandbox=250, card_acquirer=0')).toEqual({
      'bank-transfer-sandbox': 250,
      card_acquirer: 0,
    });
  });

  it('refuses a pair that does not read, a repeat, and a rate above 10000 bps', () => {
    expect(() => parsePartnerFeeBpsEnv('bank-transfer-sandbox')).toThrow(/is not <partner>=<bps>/);
    expect(() => parsePartnerFeeBpsEnv('bank-transfer-sandbox=2.5')).toThrow(/is not <partner>=<bps>/);
    expect(() => parsePartnerFeeBpsEnv('bank-transfer-sandbox=-1')).toThrow(/is not <partner>=<bps>/);
    expect(() => parsePartnerFeeBpsEnv('a=1,a=2')).toThrow(/given twice/);
    expect(() => parsePartnerFeeBpsEnv('a=10001')).toThrow(/0\.\.10000/);
  });
});
