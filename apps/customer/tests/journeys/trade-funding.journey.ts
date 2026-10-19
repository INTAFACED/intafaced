import { describe, expect, it } from 'vitest';
import { QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { claimsOf, identityCall, type Issued } from './identity';
import { payCall } from './pay';
import { fund, ledgerAvailable, newCustomer } from './stack';

/**
 * Money in and money out of the pro trader's account. Funds arrive through the ledger's deposit recipe (the one custodial
 * book); the desk and the ledger must tell the same story. Money out goes through the payments core's own door. No payout
 * rail is configured in the rig and counsel's sanctions list is unset, so the withdrawal must refuse with the named reason
 * before anything is held.
 */
const withdrawal = (clientRef: string) => ({
  assetId: QUOTE,
  amount: '10',
  railId: 'bank-payout',
  destination: { kind: 'iban', ref: 'DE89370400440532013000' },
  clientRef,
});

describe('pro trader: funding and withdrawal', () => {
  it('shows a deposit on the desk exactly as the ledger holds it, and a replayed deposit adds nothing', async () => {
    const person = await newCustomer();
    expect((await balance(person.trade, QUOTE)).total).toBe('0');

    await fund(person.userId, QUOTE, '500');
    expect(await ledgerAvailable(person.userId, QUOTE)).toBe('500');
    expect(await balance(person.trade, QUOTE)).toMatchObject({ free: '500', used: '0', total: '500' });

    await fund(person.userId, QUOTE, '500');
    expect(await ledgerAvailable(person.userId, QUOTE)).toBe('500');

    const { placed } = await reviewAndPlace(person.trade, draft({ price: '80', amount: '0.1' }));
    orderOf(placed);
    expect((await balance(person.trade, QUOTE)).total).toBe('500');
    expect(Number((await balance(person.trade, QUOTE)).used)).toBeGreaterThan(0);
    const cancelled = await person.trade.cancelAll(SYMBOL);
    expect(cancelled.ok).toBe(true);
  });

  it('refuses a withdrawal from a session that has not stepped up, and moves nothing', async () => {
    const person = await newCustomer();
    await fund(person.userId, QUOTE, '300');
    const plain = claimsOf(
      (await identityCall<Issued>('auth.login', { identifier: person.account.email, password: person.account.password }, null)).accessToken,
    );
    expect(plain.scopes).not.toContain('trade:withdraw');

    const refused = await payCall('withdrawal.create', withdrawal('journey-nostepup'), plain);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(refused.body).not.toContain('Sanctions screening');
    expect(await ledgerAvailable(person.userId, QUOTE)).toBe('300');
  });

  it('refuses a stepped-up withdrawal with the named blocker, holds nothing and records no withdrawal', async () => {
    const person = await newCustomer();
    await fund(person.userId, QUOTE, '300');
    const elevated = await person.account.stepUp();
    expect(elevated.scopes).toContain('trade:withdraw');

    // The same client reference twice: the refusal is repeatable and the second ask opens nothing.
    for (const clientRef of ['journey-w1', 'journey-w1']) {
      const refused = await payCall('withdrawal.create', withdrawal(clientRef), elevated);
      expect(refused.status).toBe(403);
      expect(refused.body).toContain('Sanctions screening list is unset');
    }
    expect(await ledgerAvailable(person.userId, QUOTE)).toBe('300');
    expect((await balance(person.trade, QUOTE)).used).toBe('0');
    const listed = await payCall('withdrawal.mine', { limit: 10 }, elevated, 'query');
    expect(listed.status).toBe(200);
    expect(listed.data).toEqual([]);
  });
});
