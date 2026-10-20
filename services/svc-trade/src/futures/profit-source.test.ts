/**
 * The payout bound — the MECHANISM, not the account choice.
 *
 * These tests prove three things: an unnamed source refuses to boot, a named
 * source that the profit recipe does not draw from refuses to boot, and a
 * payout larger than the named balance refuses instead of overdrawing.
 */
import { describe, expect, it } from 'vitest';
import { MemoryLedger, futuresLossSink, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import {
  ProfitSourceConfigError,
  checkProfitBound,
  formatAccountRef,
  optionalProfitSourceFromConfig,
  parseAccountRef,
  profitSourceFromConfig,
  recipeProfitFundingAccount,
} from './profit-source.js';

/**
 * The spelling of the account `futuresRealizeProfit` actually draws from,
 * derived rather than typed, so this suite cannot drift from the recipe either.
 */
const RECIPE_SPELLING = formatAccountRef(recipeProfitFundingAccount('USDT'));

describe('parseAccountRef', () => {
  it('parses ownerType:ownerId:kind', () => {
    expect(parseAccountRef('house:insurance-fund:available', 'USDT')).toEqual({
      ownerType: 'house',
      ownerId: 'insurance-fund',
      assetId: 'USDT',
      kind: 'available',
    });
  });

  it('keeps colons inside the owner id — `fees:trade` is one owner', () => {
    expect(parseAccountRef('house:fees:trade:available', 'USDT')).toEqual({
      ownerType: 'house',
      ownerId: 'fees:trade',
      assetId: 'USDT',
      kind: 'available',
    });
  });

  it('parses a trailing purpose', () => {
    expect(parseAccountRef('module:trade:futures-pnl:available:pool', 'USDT')).toEqual({
      ownerType: 'module',
      ownerId: 'trade:futures-pnl',
      assetId: 'USDT',
      kind: 'available',
      purpose: 'pool',
    });
  });

  it('refuses rather than guesses on a bad owner type, missing kind, or empty segment', () => {
    for (const bad of ['bank:fees:trade:available', 'house:fees:trade', 'house::available', 'house:fees:trade:available:a:b', '']) {
      expect(() => parseAccountRef(bad, 'USDT')).toThrow(ProfitSourceConfigError);
    }
  });

  it('round-trips through formatAccountRef', () => {
    for (const spelling of ['house:fees:trade:available', 'module:trade:pnl:available:pool', 'treasury:rail:sepa:available']) {
      expect(formatAccountRef(parseAccountRef(spelling, 'USDT'))).toBe(spelling);
    }
  });
});

describe('recipeProfitFundingAccount', () => {
  it('reads the funding leg off the recipe instead of restating it', () => {
    const derived = recipeProfitFundingAccount('USDT');
    const probe = recipes.futuresRealizeProfit({
      positionId: '00000000-0000-4000-8000-000000000000',
      userId: '00000000-0000-4000-8000-000000000000',
      assetId: 'USDT',
      amount: amt('1'),
      profitId: 'x',
    });
    const credit = probe.entries.find((e) => e.direction === 'credit')!;
    expect(derived).toEqual(credit.account);
  });
});

describe('profitSourceFromConfig — refuse to boot rather than default', () => {
  /** THE ADR: which account funds profit is an OWNER decision, so there is no default. */
  it('throws when unset, and says whose decision it is', () => {
    for (const unset of [undefined, '', '   ']) {
      expect(() => profitSourceFromConfig(unset)).toThrow(ProfitSourceConfigError);
    }
    try {
      profitSourceFromConfig('');
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as Error).message).toContain('TRADE_FUTURES_PROFIT_SOURCE');
      expect((err as Error).message).toContain('owner decision');
      expect((err as Error).message).toContain('no safe default');
    }
  });

  it('throws on an unparseable value at boot, not on the first profitable close', () => {
    expect(() => profitSourceFromConfig('not-an-account')).toThrow(ProfitSourceConfigError);
  });

  /**
   * Bounding one account while debiting another is not a bound — it reads like
   * a control and is not one. Naming a different pot needs a ledger recipe
   * change, which is an owner carve-out (DIRECTION §3).
   */
  it('throws when the named account is not the one the profit recipe draws from', () => {
    try {
      profitSourceFromConfig('house:insurance-fund:available');
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as Error).message).toContain('is not a bound');
      expect((err as Error).message).toContain('ledger recipe change');
      expect((err as Error).message).toContain('will not do on its own');
    }
  });

  it('accepts the account the recipe actually draws from, and reports the asset-specific ref', () => {
    const source = profitSourceFromConfig(RECIPE_SPELLING);
    expect(source.configured).toBe(RECIPE_SPELLING);
    expect(source.accountFor('USDT')).toEqual(futuresLossSink('USDT'));
    expect(source.accountFor('EUR').assetId).toBe('EUR');
  });
});

describe('checkProfitBound', () => {
  const USER = '11111111-1111-4111-8111-111111111111';

  async function fundedLedger(amount: string) {
    const ledger = new MemoryLedger();
    if (amount !== '0') {
      // Route value in through real recipes so the clearing pot's balance is a
      // posted fact, not a fixture. Losers pay into futuresLossSink (the clearing
      // pot) with a realised loss; winners are paid from it.
      const positionId = `loser-${amount}`;
      await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: `seed-${amount}` }));
      await ledger.post(recipes.futuresMarginLock({ positionId, userId: USER, assetId: 'USDT', amount: amt(amount) }));
      await ledger.post(
        recipes.futuresRealizeLoss({
          positionId,
          userId: USER,
          assetId: 'USDT',
          fromMargin: amt(amount),
          fromInsurance: 0n,
          lossId: `seed-${amount}`,
        }),
      );
    }
    return ledger;
  }

  it('passes when the source covers the payout', async () => {
    const ledger = new MemoryLedger();
    const source = profitSourceFromConfig(RECIPE_SPELLING);
    const check = await checkProfitBound({
      source,
      assetId: 'USDT',
      amount: 0n,
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(true);
  });

  it('refuses when the payout exceeds the named balance, and names the account', async () => {
    const ledger = await fundedLedger('0');
    const source = profitSourceFromConfig(RECIPE_SPELLING);
    const check = await checkProfitBound({
      source,
      assetId: 'USDT',
      amount: amt('1'),
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(false);
    expect(check.available).toBe(0n);
    expect(check.reason).toContain(formatAccountRef(futuresLossSink('USDT')));
    expect(check.reason).toContain('refusing rather than overdrawing');
  });

  it('checks the balance of the SOURCE account, not the user being paid', async () => {
    const ledger = new MemoryLedger();
    // The user is rich; the profit source is empty. The bound is the source.
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'rich' }));
    expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(amt('1000'));

    const check = await checkProfitBound({
      source: profitSourceFromConfig(RECIPE_SPELLING),
      assetId: 'USDT',
      amount: amt('1'),
      balance: (ref) => ledger.balance(ref),
    });
    expect(check.ok).toBe(false);
  });
});

/**
 * ABSENCE AND ERROR ARE DIFFERENT ANSWERS.
 *
 * `profitSourceFromConfig` treats "nobody decided" and "somebody decided wrong"
 * identically — both throw — and `index.ts` called it at module scope. Since
 * `.env.example` ships the variable commented out and compose passes
 * `${TRADE_FUTURES_PROFIT_SOURCE:-}`, that made the ABSENT case a crash-loop of
 * the whole of svc-trade: spot, ticker, orderbook, balances, fees, positions
 * and the websocket feeds, over a futures payout pot.
 *
 * The optional constructor splits the two, and the split is narrow on purpose:
 * only ABSENCE becomes `null`. Everything the owner actually wrote is validated
 * exactly as strictly as before.
 */
describe('optionalProfitSourceFromConfig', () => {
  it('returns null when nobody has named an account', () => {
    expect(optionalProfitSourceFromConfig(undefined)).toBeNull();
    expect(optionalProfitSourceFromConfig('')).toBeNull();
    expect(optionalProfitSourceFromConfig('   ')).toBeNull();
  });

  it('still throws on a value that is present and unparseable', () => {
    expect(() => optionalProfitSourceFromConfig('house:fees:trade')).toThrow(ProfitSourceConfigError);
    expect(() => optionalProfitSourceFromConfig('nonsense')).toThrow(ProfitSourceConfigError);
    expect(() => optionalProfitSourceFromConfig('wizard:fees:trade:available')).toThrow(/not a ledger owner type/);
  });

  /**
   * The one that matters most. A typo that names a REAL but WRONG account would
   * bound one pot while the recipe debits another, which is worse than no bound
   * at all because it reads like a control. Quietly disabling futures over it
   * would hide the mistake; exiting names it.
   */
  it('still throws on an account the profit recipe does not draw from', () => {
    expect(() => optionalProfitSourceFromConfig('house:insurance-fund:available')).toThrow(/Bounding one account while debiting another/);
  });

  it('returns the same source as the strict constructor for a good value', () => {
    const strict = profitSourceFromConfig(RECIPE_SPELLING);
    const optional = optionalProfitSourceFromConfig(RECIPE_SPELLING);
    expect(optional).not.toBeNull();
    expect(optional!.configured).toBe(strict.configured);
    expect(optional!.accountFor('USDT')).toEqual(strict.accountFor('USDT'));
  });
});
