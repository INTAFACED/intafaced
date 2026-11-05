import { SANDBOX_CARD_TEST_VALUES } from '@intafaced/contracts/developer-sandboxes';
import { describe, expect, it } from 'vitest';
import { safeFailure } from '../merchant-failure.js';
import {
  CardSandboxAdapter,
  SANDBOX_DECLINE_TOKEN,
  SANDBOX_ERROR_TOKEN,
  SANDBOX_FUNDS_HELD_TOKEN,
  SANDBOX_UNLISTED_DECLINE_TOKEN,
} from './card-sandbox.js';

/**
 * The developer portal's test values page (`/developers/sandbox/test-values`, J-developer-02 #8) lists the contract's
 * card test values. They must be the tokens this rail steers by, ending the way the page says, or a developer is told a
 * token does something it does not.
 */
describe('sandbox card test values match the card-sandbox rail', () => {
  it('the unlisted reason is a code the rail sends that no catalogue lists', async () => {
    const rail = new CardSandboxAdapter({ secret: 'sandbox-test-values-rail-secret-32-chars', toleranceSeconds: 300 });
    const result = await rail.authorize({
      paymentId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e14',
      merchantId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e12',
      amount: 10n * 10n ** 18n,
      assetId: 'USD',
      method: 'card',
      instrument: { kind: 'card', token: SANDBOX_UNLISTED_DECLINE_TOKEN },
    });
    expect(result).toMatchObject({ ok: false, status: 'failed', failureCode: 'card.test_unlisted_reason' });
    expect(safeFailure('card.test_unlisted_reason')).toEqual({ code: 'pay.failed', message: 'The payment could not be completed.' });
  });

  it('names exactly the tokens the rail steers by', () => {
    expect(Object.fromEntries(SANDBOX_CARD_TEST_VALUES.map((value) => [value.id, value.token]))).toEqual({
      decline: SANDBOX_DECLINE_TOKEN,
      acquirer_outage: SANDBOX_ERROR_TOKEN,
      funds_held: SANDBOX_FUNDS_HELD_TOKEN,
      unlisted_reason: SANDBOX_UNLISTED_DECLINE_TOKEN,
    });
  });

  it.each(SANDBOX_CARD_TEST_VALUES.filter((value) => value.failureCode !== null))(
    'the $id token ends the authorization failed with $failureCode',
    async ({ token, failureCode }) => {
      const rail = new CardSandboxAdapter({ secret: 'sandbox-test-values-rail-secret-32-chars', toleranceSeconds: 300 });
      const result = await rail.authorize({
        paymentId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e11',
        merchantId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e12',
        amount: 10n * 10n ** 18n,
        assetId: 'USD',
        method: 'card',
        instrument: { kind: 'card', token },
      });
      expect(result).toMatchObject({ ok: false, status: 'failed' });
      // The code the page names is the one the payment then carries on every read: the catalogue's (merchant-failure.ts).
      expect(safeFailure(result.ok ? null : result.failureCode)?.code).toBe(failureCode);
    },
  );

  it.each(SANDBOX_CARD_TEST_VALUES.filter((value) => value.failureCode === null))(
    'the $id token authorizes, ending $status as the page says',
    async ({ token, status }) => {
      const rail = new CardSandboxAdapter({ secret: 'sandbox-test-values-rail-secret-32-chars', toleranceSeconds: 300 });
      const result = await rail.authorize({
        paymentId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e13',
        merchantId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e12',
        amount: 10n * 10n ** 18n,
        assetId: 'USD',
        method: 'card',
        instrument: { kind: 'card', token },
      });
      expect(result).toMatchObject({ ok: true, status });
    },
  );
});
