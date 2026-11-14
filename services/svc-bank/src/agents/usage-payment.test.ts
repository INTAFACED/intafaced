import { describe, expect, it } from 'vitest';
import { testPartner } from '../partner/test-partner.js';
import type { PostingFreeze } from '../partner/partner-bank.js';
import { collectUsagePayment, partnerIntafacedAccount, readUsagePayment, type UsagePaymentDeps } from './usage-payment.js';

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = 'agent.usage:22222222-2222-4222-8222-222222222222:2026-11-15#0012';
const open: PostingFreeze = { postingEnabled: async () => true };
const frozen: PostingFreeze = { postingEnabled: async () => false };

function setup(freeze: PostingFreeze = open) {
  const partner = testPartner();
  partner.set(USER, { custody: 'off' });
  partner.fund(USER, { fundId: 'fund-usage-1', assetId: 'USDT', amount: 10_000_000_000_000_000_000n });
  const deps: UsagePaymentDeps = {
    freeze,
    heldBy: (userId) =>
      partner.switches(userId).custody === 'off' ? { kind: 'partner', bank: partner.bank, partnerId: 'test' } : { kind: 'ledger' },
  };
  const collect = (amount = '0.0123') =>
    collectUsagePayment(deps, { action: 'collect', userId: USER, assetId: 'USDT', amount, chargeKey: KEY });
  const has = async (ref = { userId: USER, assetId: 'USDT', spaceId: null }) => (await partner.bank.balance(ref)).amount;
  return { partner, deps, collect, has };
}

describe('agent usage payment at the partner (J-agents-01)', () => {
  it('reads where the money is held and what the partner reports', async () => {
    const { deps, partner } = setup();
    expect(await readUsagePayment(deps, USER, 'USDT')).toMatchObject({ heldBy: 'partner', label: 'TEST partner bank', available: '10' });
    partner.set(USER, { figures: 'unknown' });
    expect(await readUsagePayment(deps, USER, 'USDT')).toMatchObject({ heldBy: 'partner', available: null, asOf: null });
    partner.set(USER, { custody: 'on' });
    expect(await readUsagePayment(deps, USER, 'USDT')).toEqual({ heldBy: 'ledger' });
  });

  it('collects one window once: the same key twice is one payment, from the person to INTAFACED at the partner', async () => {
    const { collect, has } = setup();
    const first = await collect();
    const second = await collect();
    expect(first).toMatchObject({ ok: true, partnerId: 'test', amount: '0.0123' });
    expect(second).toEqual(first);
    expect(await has()).toBe(10_000_000_000_000_000_000n - 12_300_000_000_000_000n);
    expect(await has(partnerIntafacedAccount('USDT'))).toBe(12_300_000_000_000_000n);
  });

  it('refuses by name and moves nothing: too little, partner down, posting frozen, not partner-held', async () => {
    const poor = setup();
    expect(await poor.collect('11')).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(await poor.has()).toBe(10_000_000_000_000_000_000n);

    const down = setup();
    down.partner.set(USER, { down: true });
    expect(await down.collect()).toEqual({ ok: false, reason: 'partner_unavailable' });

    const ice = setup(frozen);
    expect(await ice.collect()).toEqual({ ok: false, reason: 'posting_frozen' });
    expect(await ice.has()).toBe(10_000_000_000_000_000_000n);

    const custodial = setup();
    custodial.partner.set(USER, { custody: 'on' });
    expect(await custodial.collect()).toEqual({ ok: false, reason: 'not_partner_held' });
  });

  it('a lost answer is asked again under the same key and makes the payment once', async () => {
    const { partner, collect, has } = setup();
    partner.set(USER, { nextReply: 'lost' });
    expect(await collect()).toEqual({ ok: false, reason: 'reply_lost' });
    const again = await collect();
    expect(again.ok).toBe(true);
    expect(await has()).toBe(10_000_000_000_000_000_000n - 12_300_000_000_000_000n);
  });

  it('a payment already made is answered as made while posting is frozen, and nothing moves again', async () => {
    const { deps, collect, has } = setup();
    const made = await collect();
    const later = await collectUsagePayment(
      { ...deps, freeze: frozen },
      { action: 'collect', userId: USER, assetId: 'USDT', amount: '0.0123', chargeKey: KEY },
    );
    expect(later).toEqual(made);
    expect(await has()).toBe(10_000_000_000_000_000_000n - 12_300_000_000_000_000n);
  });
});
