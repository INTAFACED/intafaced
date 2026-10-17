import { describe, expect, it } from 'vitest';
import { plainFailure } from './refusal';
import './payments/refusals';

describe('plainFailure', () => {
  it('turns a message that carries a service code into words', () => {
    const out = plainFailure({
      ok: false,
      reason: 'error',
      code: 'pay.subscription_already_open',
      message: 'pay.subscription_already_open',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toBe('This customer already has a subscription on this mandate. Open it from the subscriptions list.');
      expect(out.message).not.toMatch(/pay\./);
    }
  });
  it('never shows an unknown code', () => {
    const out = plainFailure({ ok: false, reason: 'error', code: 'pay.something_new', message: 'pay.something_new: boom' });
    if (!out.ok) expect(out.message).not.toMatch(/pay\./);
  });
  it('leaves plain messages and successes alone', () => {
    const plain = { ok: false as const, reason: 'error' as const, message: 'Nothing was created.' };
    expect(plainFailure(plain)).toBe(plain);
    const good = { ok: true as const, data: 1 };
    expect(plainFailure(good)).toBe(good);
  });
});
