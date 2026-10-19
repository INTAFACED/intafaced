import { describe, expect, it } from 'vitest';
import { orderSchema } from '../../src/features/trade/trade-api';
import { QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { fund, ledgerAvailable, newCustomer, type Customer } from './stack';

/**
 * The pro trader's real onboarding: sign up, ask to be verified, get approved by two operators through identity's own
 * path, sign in again, and only then trade. Until then every door refuses with the typed reason and nothing is held.
 */
async function refusedWithNothingHeld(c: Customer) {
  const d = draft();
  const review = await c.trade.preview(d);
  expect(review.ok).toBe(true);
  if (!review.ok) return;
  expect(review.data.orderable).toBe(false);
  expect(review.data.refusals.map((r) => r.code)).toContain('denied.kyc_required');

  const sent = await c.api.rest('/orders', orderSchema, { method: 'POST', body: d });
  expect(sent.ok).toBe(false);
  if (!sent.ok) expect(sent.reason).toBe('forbidden');
  const open = await c.trade.orders('open', SYMBOL);
  expect(open.ok && open.data).toEqual([]);
  expect((await balance(c.trade, QUOTE)).used).toBe('0');
  expect(await ledgerAvailable(c.userId, QUOTE)).toBe('1000');
}

describe('pro trader: onboarding to the first order', () => {
  it('is refused while only signed up, and while the verification request is pending', async () => {
    const fresh = await newCustomer({ onboarding: 'signed_up' });
    await fund(fresh.userId, QUOTE, '1000');
    await refusedWithNothingHeld(fresh);

    const pending = await newCustomer({ onboarding: 'kyc_pending' });
    await fund(pending.userId, QUOTE, '1000');
    await refusedWithNothingHeld(pending);
  });

  it('trades after two operators approve the request and the customer signs in again', async () => {
    const person = await newCustomer({ onboarding: 'kyc_pending' });
    await fund(person.userId, QUOTE, '1000');
    await person.account.approveKyc();
    const verified = await person.account.signIn();
    expect(verified.session.tier).toBe('basic');

    const { placed } = await reviewAndPlace(verified.trade, draft({ price: '40' }));
    const order = orderOf(placed);
    expect(order.status).toBe('open');
    await verified.trade.cancel(order);
  });
});
