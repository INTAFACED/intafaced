import { describe, expect, it } from 'vitest';
import { plainFailure } from '../refusal';
import './refusals';

describe('the service’s KYB money gate', () => {
  it('pay.kyb_required reads as plain words: nothing sent, payouts open once verification is approved', () => {
    const out = plainFailure({ ok: false, reason: 'error', code: 'pay.kyb_required', message: 'pay.kyb_required' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toBe('Nothing was sent. Payouts open once your business verification is approved.');
      expect(out.message).not.toMatch(/pay\./);
    }
  });
});
