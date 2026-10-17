import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt, sub } from '../money.js';
import { insuranceFund, merchantClearing, merchantProceeds, railBoundary, userAvailable } from '../accounts.js';
import { InsufficientFundsError, InvalidEntryError } from '../types.js';
import { recipes } from './index.js';

/**
 * THE CHARGEBACK RECIPE.
 *
 * ⚠ OWNER SIGN-OFF REQUIRED BEFORE MERGE — DIRECTION §3 Class M carve-out. This
 * suite exists so the decision is made against something that provably behaves
 * the way the file claims, rather than against a description of it.
 *
 * The four questions the owner is signing off on, one section each:
 *
 *   1. Who is debited when a chargeback lands.
 *   2. Where the loss sits when the merchant cannot cover it.
 *   3. What happens when the backstop is also empty  — IT FAILS.
 *   4. How the money comes back if the representment succeeds.
 *
 * Nothing in svc-pay calls any of this. A card rail cannot report a dispute yet
 * because there is no card rail; what the ADR of 2026-08-04 required is that the
 * compensating entry EXIST before one is written, so a rail is never in the
 * position of having to be dishonest about what it did.
 */

const MERCHANT = '33333333-3333-4333-8333-333333333333';
const MERCHANT_USER = '44444444-4444-4444-8444-444444444444';
const PAYER_RAIL = 'card-acquirer';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

/** A payment captured at the rail and sitting in the merchant's clearing pot. */
async function capture(paymentId: string, amount: string): Promise<void> {
  await ledger.post(
    recipes.paymentCapture({
      paymentId,
      merchantId: MERCHANT,
      assetId: 'USDT',
      amount: amt(amount),
      rail: PAYER_RAIL,
      railRef: `ch_${paymentId}`,
    }),
  );
}

/** …and then settled, so the merchant can actually spend it. */
async function settle(window: string, gross: string, fee: string): Promise<void> {
  await ledger.post(
    recipes.merchantSettlement({
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      window,
      assetId: 'USDT',
      gross: amt(gross),
      fee: amt(fee),
    }),
  );
}

const clearing = async () => formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USDT'))).amount);
const merchantBalance = async () => formatAmount((await ledger.balance(merchantProceeds(MERCHANT, 'USDT'))).amount);
const fund = async () => formatAmount((await ledger.balance(insuranceFund('USDT'))).amount);
const boundary = async () => formatAmount((await ledger.balance(railBoundary(PAYER_RAIL, 'USDT'))).amount);

// ══ 1 · WHO IS DEBITED ══════════════════════════════════════════════════════

describe('a chargeback lands — the money leaves, and the book says whose it was', () => {
  it('takes it out of clearing when the window has not settled yet', async () => {
    await capture('p1', '100');
    expect(await clearing()).toBe('100');

    await ledger.post(
      recipes.chargebackOpen({
        disputeId: 'dp_1',
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('100'),
        fromMerchantBalance: amt('0'),
      }),
    );

    expect(await clearing()).toBe('0');
    // The value went back out through the boundary it came in on. `-100` here is
    // the platform's obligation to the outside world, which is exactly what a
    // treasury account is for.
    expect(await boundary()).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('takes it out of the merchant’s spendable balance after settlement', async () => {
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');
    expect(await clearing()).toBe('0');
    expect(await merchantBalance()).toBe('100');

    await ledger.post(
      recipes.chargebackOpen({
        disputeId: 'dp_1',
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('0'),
        fromMerchantBalance: amt('100'),
      }),
    );

    expect(await merchantBalance()).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('SPANS BOTH POTS in one posting — the common real case, not an edge case', async () => {
    // A merchant with a settled balance and an unsettled window is the normal
    // shape of a live merchant. A chargeback that arrives then is covered partly
    // by each, and forcing one pot would either fail a chargeback the merchant
    // could actually cover or split one removal of money into two events a
    // reader cannot tell were the same one.
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');
    await capture('p2', '40');

    expect(await merchantBalance()).toBe('100');
    expect(await clearing()).toBe('40');

    await ledger.post(
      recipes.chargebackOpen({
        disputeId: 'dp_1',
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('40'),
        fromMerchantBalance: amt('60'),
      }),
    );

    expect(await clearing()).toBe('0');
    expect(await merchantBalance()).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('is keyed on the DISPUTE, so a second dispute of the same charge is a second debit', async () => {
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');

    const leg = (disputeId: string) =>
      recipes.chargebackOpen({
        disputeId,
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('0'),
        fromMerchantBalance: amt('40'),
      });

    await ledger.post(leg('dp_1'));
    // A second presentment, or an arbitration after a won representment. Keyed
    // on the payment this would find the first transaction, return it, and book
    // NOTHING for a second real removal of money.
    await ledger.post(leg('dp_2'));

    expect(await merchantBalance()).toBe('20');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('is idempotent on redelivery of the SAME dispute', async () => {
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');

    const post = () =>
      recipes.chargebackOpen({
        disputeId: 'dp_1',
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('0'),
        fromMerchantBalance: amt('40'),
      });

    const first = await ledger.post(post());
    const second = await ledger.post(post());

    // A dispute webhook WILL be delivered twice. That is normal traffic.
    expect(second.id).toBe(first.id);
    expect(await merchantBalance()).toBe('60');
  });

  it('refuses a chargeback of nothing — in the recipe, before the ledger sees it', () => {
    // A recipe is a pure function, so its refusals are synchronous and arrive
    // before any I/O. That is the earliest a caller mistake can be caught.
    expect(() =>
      recipes.chargebackOpen({
        disputeId: 'dp_0',
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('0'),
        fromMerchantBalance: amt('0'),
      }),
    ).toThrow(InvalidEntryError);
  });

  it('refuses a negative leg rather than letting one leg fund the other', () => {
    // Without this, `fromClearing: 100, fromMerchantBalance: -1` sums to 99, the
    // transaction balances, and the merchant's spendable balance is CREDITED a
    // unit by a chargeback.
    expect(() =>
      recipes.chargebackOpen({
        disputeId: 'dp_neg',
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('100'),
        fromMerchantBalance: -1n,
      }),
    ).toThrow(InvalidEntryError);
  });
});

// ══ 2 · WHERE THE LOSS SITS ═════════════════════════════════════════════════

describe('the merchant cannot cover it', () => {
  it('REFUSES to overdraw the merchant — the whole posting fails, nothing half-settles', async () => {
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');
    // The merchant has spent most of it. This is the ordinary case: settlement
    // ran days ago and the money is gone.
    await ledger.post(
      recipes.merchantProceedsPayoutHold({
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('90'),
        rail: 'crypto-native',
        withdrawalId: 'w1',
      }),
    );
    await ledger.post(
      recipes.deposit({ userId: MERCHANT_USER, assetId: 'USDT', amount: amt('500'), rail: 'test', railRef: 'personal-untouched' }),
    );
    expect(await merchantBalance()).toBe('10');

    await expect(
      ledger.post(
        recipes.chargebackOpen({
          disputeId: 'dp_1',
          paymentId: 'p1',
          merchantId: MERCHANT,
          merchantUserId: MERCHANT_USER,
          assetId: 'USDT',
          rail: PAYER_RAIL,
          fromClearing: amt('0'),
          fromMerchantBalance: amt('100'),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    // Nothing moved. Not proceeds, and not the owner's trading balance.
    expect(await merchantBalance()).toBe('10');
    expect(formatAmount((await ledger.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('500');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('covers what the merchant has, and names the rest as a platform loss', async () => {
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');
    await ledger.post(
      recipes.merchantProceedsPayoutHold({
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('90'),
        rail: 'crypto-native',
        withdrawalId: 'w1',
      }),
    );
    // Fund the backstop out of fee revenue the platform actually earned.
    await capture('p2', '500');
    await settle('2026-08-02', '500', '200');
    await ledger.post(insuranceTopupFromPayFees(amt('200')));
    expect(await fund()).toBe('200');

    const merchantHas = await merchantBalance();

    // 100 was taken by the bank. The merchant can cover 10 of it.
    await ledger.post(
      recipes.chargebackOpen({
        disputeId: 'dp_1',
        paymentId: 'p1',
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        fromClearing: amt('0'),
        fromMerchantBalance: amt('10'),
      }),
    );
    await ledger.post(
      recipes.chargebackShortfall({
        disputeId: 'dp_1',
        paymentId: 'p1',
        merchantId: MERCHANT,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        amount: amt('90'),
      }),
    );

    expect(formatAmount(sub(amt(merchantHas), amt(await merchantBalance())))).toBe('10');
    // The loss has a name, a source account, and a posting an operator can
    // query. Without it the boundary would simply be 90 more negative than
    // custody says, nothing would error, and the only evidence of a loss would
    // look exactly like an ordinary payout in flight.
    expect(await fund()).toBe('110');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});

// ══ 3 · WHEN THE BACKSTOP IS ALSO EMPTY ═════════════════════════════════════

describe('the insurance fund cannot cover it either — this FAILS, on purpose', () => {
  /**
   * `loanBadDebt` is the model and the precedent is exact: *"A platform that
   * cannot name where a loss came from should not be able to absorb it silently;
   * an operator seeing this refuse is an operator who has learned something true
   * on the day it became true."*
   */
  it('refuses when the fund is EMPTY', async () => {
    expect(await fund()).toBe('0');

    await expect(
      ledger.post(
        recipes.chargebackShortfall({
          disputeId: 'dp_1',
          paymentId: 'p1',
          merchantId: MERCHANT,
          assetId: 'USDT',
          rail: PAYER_RAIL,
          amount: amt('50'),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await fund()).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses when the fund is merely SHORT, rather than absorbing what it can', async () => {
    await capture('p1', '500');
    await settle('2026-08-01', '500', '100');
    await ledger.post(insuranceTopupFromPayFees(amt('100')));
    expect(await fund()).toBe('100');

    await expect(
      ledger.post(
        recipes.chargebackShortfall({
          disputeId: 'dp_1',
          paymentId: 'p1',
          merchantId: MERCHANT,
          assetId: 'USDT',
          rail: PAYER_RAIL,
          amount: amt('150'),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    // Not 0, and not -50. The fund is untouched, because a partial absorption
    // would be the platform quietly deciding how much of a loss it could take
    // without telling anyone.
    expect(await fund()).toBe('100');
  });

  it('is keyed on the dispute, so a redelivered shortfall does not drain the fund twice', async () => {
    await capture('p1', '500');
    await settle('2026-08-01', '500', '100');
    await ledger.post(insuranceTopupFromPayFees(amt('100')));

    const shortfall = () =>
      recipes.chargebackShortfall({
        disputeId: 'dp_1',
        paymentId: 'p1',
        merchantId: MERCHANT,
        assetId: 'USDT',
        rail: PAYER_RAIL,
        amount: amt('40'),
      });

    const first = await ledger.post(shortfall());
    const second = await ledger.post(shortfall());
    expect(second.id).toBe(first.id);
    expect(await fund()).toBe('60');
  });
});

// ══ 4 · HOW THE MONEY COMES BACK ════════════════════════════════════════════

describe('we won the representment', () => {
  it('returns the value to the SAME pots, in the same proportions', async () => {
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');
    await capture('p2', '40');

    const open = {
      disputeId: 'dp_1',
      paymentId: 'p1',
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      rail: PAYER_RAIL,
      fromClearing: amt('40'),
      fromMerchantBalance: amt('60'),
    };

    await ledger.post(recipes.chargebackOpen(open));
    await ledger.post(recipes.chargebackWon(open));

    // Back exactly where it was. Returning the whole 100 to `available` would
    // have been the intuitive thing and would have settled 40 of it at zero fee,
    // leaving clearing permanently understating what we owe this merchant.
    expect(await clearing()).toBe('40');
    expect(await merchantBalance()).toBe('100');
    // The boundary is back to exactly what the two captures put there — 140 of
    // obligation to the outside world, and no trace of the round trip in the
    // NUMBER, which is why the round trip has to be visible in the JOURNAL.
    expect(await boundary()).toBe('-140');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('repays the insurance fund through its OWN recipe, not as a third leg', async () => {
    await capture('p1', '500');
    await settle('2026-08-01', '500', '100');
    await ledger.post(insuranceTopupFromPayFees(amt('100')));

    const shortfall = {
      disputeId: 'dp_1',
      paymentId: 'p1',
      merchantId: MERCHANT,
      assetId: 'USDT',
      rail: PAYER_RAIL,
      amount: amt('60'),
    };

    await ledger.post(recipes.chargebackShortfall(shortfall));
    expect(await fund()).toBe('40');

    // A dispute can be won after the merchant has been closed, in which case the
    // fund is repaid and there is nobody left to credit. Fusing this into
    // `chargebackWon` would make that case unpostable.
    await ledger.post(recipes.chargebackShortfallRecovered(shortfall));
    expect(await fund()).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('leaves the journal showing both halves — a ledger reverses, it does not amend', async () => {
    await capture('p1', '100');
    await settle('2026-08-01', '100', '0');

    const open = {
      disputeId: 'dp_1',
      paymentId: 'p1',
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      rail: PAYER_RAIL,
      fromClearing: amt('0'),
      fromMerchantBalance: amt('100'),
    };
    await ledger.post(recipes.chargebackOpen(open));
    await ledger.post(recipes.chargebackWon(open));

    const reasons = ledger.journal().map((t) => t.reason);
    expect(reasons).toContain('pay.chargeback.opened');
    expect(reasons).toContain('pay.chargeback.won');
    // Which is also the only way an operator can ever compute a true dispute
    // win rate: both events are in the journal, not one net figure.
  });
});

// ══ THE LOSING PATH POSTS NOTHING ═══════════════════════════════════════════

describe('lost, accepted and expired', () => {
  it('have no recipe, and that is the design', () => {
    // The money left at `chargebackOpen`, when the payer's bank took it. The
    // three terminal statuses record which way the argument went, and an
    // argument is not a movement. A recipe for "we lost" would double-debit.
    const names = Object.keys(recipes).filter((n) => n.startsWith('chargeback'));
    expect(names.sort()).toEqual(['chargebackOpen', 'chargebackShortfall', 'chargebackShortfallRecovered', 'chargebackWon']);
  });
});

// ── helper ───────────────────────────────────────────────────────────────────

/**
 * Fund the insurance backstop out of `pay` fee revenue.
 *
 * `futuresInsuranceTopup` draws on `houseFees('trade')`, which is the wrong pot
 * for a pay-side chargeback fixture, so this test states the transfer inline
 * rather than adding a recipe the owner has not been asked about. It is a
 * fixture, not a proposal: how the pay-side backstop gets funded in production
 * is exactly the kind of policy that belongs to the owner and not to this file.
 */
function insuranceTopupFromPayFees(amount: bigint) {
  return {
    idempotencyKey: `test.insurance.topup:${amount.toString()}:${Math.random()}`,
    module: 'pay',
    reason: 'test.insurance.funded',
    entries: [
      {
        account: { ownerType: 'house' as const, ownerId: 'fees:pay', assetId: 'USDT', kind: 'available' as const },
        direction: 'credit' as const,
        amount,
      },
      { account: insuranceFund('USDT'), direction: 'debit' as const, amount },
    ],
  };
}
