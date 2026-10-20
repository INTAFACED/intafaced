import { describe, expect, it } from 'vitest';
import { checkSendFields, parseSendFieldRules } from './send-fields.js';

const full = {
  reference: [{ deliveryMethod: 'bank', maxLength: 18 }],
  purposeRequired: ['INR'],
  sourceOfFunds: [{ asset: 'USDT', threshold: '50' }],
};

describe('owner table for send fields', () => {
  it('is unreadable, never "nothing required", when blank, not JSON, not in shape or missing a key', () => {
    for (const bad of [
      undefined,
      '',
      '  ',
      'not json',
      '[]',
      '{}',
      JSON.stringify({ reference: full.reference }),
      JSON.stringify({ ...full, sourceOfFunds: undefined }),
    ]) {
      expect(parseSendFieldRules(bad)).toBeNull();
    }
    expect(parseSendFieldRules(JSON.stringify({ ...full, extra: 1 }))).toBeNull();
    expect(parseSendFieldRules(JSON.stringify({ ...full, sourceOfFunds: [{ asset: 'USDT', threshold: '9'.repeat(40) }] }))).toBeNull();
  });

  it('reads an explicit empty list as "none", and a refusal for a null table', () => {
    const rules = parseSendFieldRules(JSON.stringify({ reference: [], purposeRequired: [], sourceOfFunds: [] }));
    expect(rules).not.toBeNull();
    const ctx = { assetId: 'USDT', amount: '1000000', toCurrency: 'INR', country: 'DE', deliveryMethod: 'bank', compliance: {} };
    expect(checkSendFields(rules, ctx)).toBeNull();
    expect(checkSendFields(null, ctx)).toEqual({ code: 'bank.send_field_rules_unset' });
  });

  it('matches the source asset without regard to case', () => {
    const rules = parseSendFieldRules(JSON.stringify(full));
    const ctx = { assetId: 'usdt', amount: '51', toCurrency: 'EUR', country: 'DE', deliveryMethod: 'bank', compliance: {} };
    expect(checkSendFields(rules, ctx)).toEqual({ code: 'bank.source_of_funds_required' });
  });
});
