import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import {
  InvalidEntryError,
  MemoryLedger,
  formatAmount,
  houseFees,
  insuranceFund,
  loanCollateralAccount,
  loanReserve,
  marketMaker,
  parseAmount as amt,
  recipes,
  userAvailable,
  userCollateral,
  type PostRequest,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS,
  LoanService,
  marketMakerVenue,
  type LiquidationVenue,
  type MarginCallSink,
} from './loan-service.js';
import { DEFAULT_MARK_POLICY, acceptableForLiquidation, acceptableForMarking, fixedPriceSource, type QuotedMark } from './prices.js';
import {
  DEFAULT_LIQUIDATION_POLICY,
  RiskError,
  accrualDay,
  assertPolicyCoherent,
  dailyLoanInterest,
  daysToAccrue,
  isMarginCallCured,
  ltvBps,
  planLiquidation,
  splitProceeds,
} from './risk.js';

/**
 * LOANS (§8.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH DATABASE THIS RUNS AGAINST, AND WHY IT IS NOT THE SHARED ONE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bank-service.test.ts` truncates the `bank` schema in `beforeEach`. Done on a
 * shared database that has already broken `main` once from an unrelated branch,
 * and a second file doing it makes the race worse, not equal.
 *
 * This suite therefore gets a database of its OWN, created and dropped per run
 * by `createTestDatabase`. It issues no DDL and no TRUNCATE against anything
 * shared, so `bank-service.test.ts` running in a parallel vitest worker — or in
 * another worktree entirely — cannot see any of it.
 *
 * The URL names the ADMIN database it creates that database FROM, and must end
 * in `_test`: `assertTestDatabase` asks the server for `current_database()` and
 * refuses anything else, so a `TEST_DATABASE_URL` still pointing at the shared
 * `intafaced` in someone's stale `.env` fails loudly rather than truncating it.
 *
 * The pure-arithmetic and recipe suites below need no database at all and always
 * run.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BANK_INIT = readFileSync(join(here, '..', '..', 'drizzle', '0000_bank_init.sql'), 'utf8');
const POSITION_PENDING = readFileSync(join(here, '..', '..', 'drizzle', '0001_position_pending.sql'), 'utf8');
const LOANS_MIGRATION = readFileSync(join(here, '..', '..', 'drizzle', '0002_bank_loans.sql'), 'utf8');
const OPENING_COLLATERAL = readFileSync(join(here, '..', '..', 'drizzle', '0008_loan_opening_collateral.sql'), 'utf8');
const RESERVE_FUNDINGS = readFileSync(join(here, '..', '..', 'drizzle', '0009_loan_reserve_fundings.sql'), 'utf8');
const SETTLED_HAS_TX = readFileSync(join(here, '..', '..', 'drizzle', '0017_loan_settled_has_ledger_tx.sql'), 'utf8');
const OPS_READS = readFileSync(join(here, '..', '..', 'drizzle', '0040_bank_ops_reads.sql'), 'utf8');
const INTEREST_CORRECTIONS = readFileSync(join(here, '..', '..', 'drizzle', '20261024143716_loan_interest_corrections.sql'), 'utf8');

const BORROWER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * Funding stand-ins for the market maker and the insurance fund.
 *
 * They were `'mm-funder'`, `'mm'` and `'ins'`. A `user` owner_id is now
 * required to be a UUID (§4.2 `accounts_owner_id_space_ck`) — an account is
 * never opened for an owner whose identifier space is undeclared — so these
 * carry real ones. The names are kept in the comment because that is all they
 * ever were: a wallet to push value out of, not an assertion about handles.
 */
const MM_FUNDER = '33333333-3333-4333-8333-333333333333';
const MM_SWEEP = '44444444-4444-4444-8444-444444444444';
const INSURANCE_FUNDER = '55555555-5555-4555-8555-555555555555';

const DAY_MS = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// 1 · ARITHMETIC — no database, no ledger, no clock.
// ═══════════════════════════════════════════════════════════════════════════════

describe('LTV is integer arithmetic, and rounds against optimism', () => {
  it('computes basis points exactly, with no float anywhere in the path', () => {
    // 5000 debt against 10000 collateral = 50%.
    expect(ltvBps(amt('5000'), amt('10000'))).toBe(5_000);
    expect(ltvBps(amt('7500'), amt('10000'))).toBe(7_500);
    expect(ltvBps(amt('1'), amt('3'))).toBe(3_334); // 33.33…% → ceil
  });

  /**
   * THE ROUNDING BUG THIS FILE EXISTS TO CATCH.
   *
   * The natural implementation reaches for `div()`, which returns a SCALED
   * result — so rounding it up at the 10^-18 place and then dividing by the scale
   * to get whole bps silently floors the answer. A loan sitting exactly on the
   * liquidation threshold then reads as one tick BELOW it and is not liquidated.
   * This asserts the ceil survives.
   */
  it('rounds UP, so a position fractionally over a threshold is treated as over it', () => {
    // A debt one attounit above exactly 75% of the collateral.
    const collateral = amt('10000');
    const debt = amt('7500') + 1n;
    expect(ltvBps(debt, collateral)).toBe(7_501);

    // And exactly on the line stays on the line — ceil of an exact value is itself.
    expect(ltvBps(amt('7500'), collateral)).toBe(7_500);
  });

  it('reports zero collateral against real debt as unsecured, not as an error or an Infinity', () => {
    expect(ltvBps(amt('100'), 0n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(ltvBps(0n, 0n)).toBe(0);
  });

  it('never accepts a float anywhere — every input and output is a bigint or an integer', () => {
    const result = ltvBps(amt('0.1') + amt('0.2'), amt('1'));
    // 0.1 + 0.2 is exactly 0.3 in scaled bigint. In float it is not.
    expect(result).toBe(3_000);
  });
});

describe('daily loan interest', () => {
  it('rounds DOWN, in the borrower&apos;s favour', () => {
    // 1000 at 10% APR over 365 days = 0.273972602739726027…
    const daily = dailyLoanInterest(amt('1000'), 1_000);
    expect(formatAmount(daily)).toBe('0.273972602739726027');
  });

  it('is zero for a zero rate and for a settled loan', () => {
    expect(dailyLoanInterest(amt('1000'), 0)).toBe(0n);
    expect(dailyLoanInterest(0n, 1_000)).toBe(0n);
  });

  it('refuses a negative or non-integer rate rather than coercing one', () => {
    expect(() => dailyLoanInterest(amt('1000'), -1)).toThrow(RiskError);
    expect(() => dailyLoanInterest(amt('1000'), 12.5)).toThrow(RiskError);
  });

  /**
   * COMPOUNDING, CHECKED BY HAND.
   *
   * Three days at 36.5% APR (0.1%/day) on 1000: each day is computed on the
   * PREVIOUS day's closing debt, so day two is charged on 1001 and not on 1000.
   */
  it('compounds day by day rather than charging simple interest three times', () => {
    let debt = amt('1000');
    const charges: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const c = dailyLoanInterest(debt, 3_650);
      charges.push(c);
      debt += c;
    }
    expect(formatAmount(charges[0]!)).toBe('1');
    // Day two is charged on 1001, so it is strictly larger than day one.
    expect(charges[1]!).toBeGreaterThan(charges[0]!);
    expect(charges[2]!).toBeGreaterThan(charges[1]!);
  });
});

describe('the accrual day list — the idempotency arithmetic', () => {
  const opened = new Date('2026-01-01T12:00:00Z');

  it('charges nothing on the day a loan opens', () => {
    expect(daysToAccrue(null, opened, new Date('2026-01-01T23:59:00Z'))).toEqual([]);
  });

  it('charges one day, once, the next day', () => {
    expect(daysToAccrue(null, opened, new Date('2026-01-02T00:00:01Z'))).toEqual(['2026-01-02']);
  });

  /** A crashed job that comes back three days later charges three days, once each. */
  it('catches up every missed day and no day twice', () => {
    expect(daysToAccrue('2026-01-02', opened, new Date('2026-01-05T06:00:00Z'))).toEqual(['2026-01-03', '2026-01-04', '2026-01-05']);
  });

  it('re-running a day that has already been charged produces an empty list', () => {
    expect(daysToAccrue('2026-01-05', opened, new Date('2026-01-05T23:00:00Z'))).toEqual([]);
  });

  /**
   * A YEAR OF UNATTENDED COMPOUNDING IS AN INCIDENT, NOT A BATCH.
   *
   * Charging 400 compounding days in one unattended run is not how anyone should
   * discover that accrual stopped, and the borrower's LTV would move by the
   * width of the outage in a single tick.
   */
  it('refuses a backlog too large to compound unattended', () => {
    expect(() => daysToAccrue('2026-01-01', opened, new Date('2027-06-01T00:00:00Z'))).toThrow(/refusing to compound/i);
  });

  it('formats the day in UTC, never local time', () => {
    expect(accrualDay(new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-01');
  });
});

describe('policy coherence', () => {
  it('accepts the shipped default', () => {
    expect(() => assertPolicyCoherent(DEFAULT_LIQUIDATION_POLICY, 6_000)).not.toThrow();
  });

  it('refuses thresholds that would liquidate a loan before it is ever called', () => {
    expect(() => assertPolicyCoherent({ ...DEFAULT_LIQUIDATION_POLICY, liquidationLtvBps: 7_000, marginCallLtvBps: 7_500 }, 6_000)).toThrow(
      /Incoherent policy/,
    );
  });

  it('refuses a liquidation target that leaves the loan still in margin call', () => {
    expect(() => assertPolicyCoherent({ ...DEFAULT_LIQUIDATION_POLICY, targetLtvBps: 7_600 }, 6_000)).toThrow(/still in margin call/);
  });

  it('refuses an opening LTV at or above the margin-call threshold', () => {
    // Otherwise every loan is in margin call from the moment it is drawn.
    expect(() => assertPolicyCoherent(DEFAULT_LIQUIDATION_POLICY, 7_500)).toThrow(/Incoherent policy/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2 · THE LADDER — margin call before liquidation, and partial before total.
// ═══════════════════════════════════════════════════════════════════════════════

describe('planLiquidation', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const mark = (price: string, assetId = 'BTC'): QuotedMark => ({ assetId, price: amt(price), asOf: now, quality: 'mid' });
  const usdt = mark('1', 'USDT');

  const base = {
    debtMark: usdt,
    policy: DEFAULT_LIQUIDATION_POLICY,
    now,
  };

  it('does nothing to a healthy loan', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('5000'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: null,
    });
    expect(rung.action).toBe('none');
    expect(rung.ltvBps).toBe(5_000);
  });

  it('raises a margin call between the call and liquidation thresholds', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('8000'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: null,
    });
    expect(rung.action).toBe('margin-call');
    expect(rung.ltvBps).toBe(8_000);
  });

  /**
   * THE ORDERING GUARANTEE — the single most important assertion in this file.
   *
   * A loan whose LTV crosses the liquidation threshold with NO margin call on
   * record is called, not liquidated. Without this the borrower's first notice of
   * the loan would be its liquidation receipt.
   */
  it('will NOT liquidate a loan that has never been called, however bad the LTV', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('9000'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: null,
    });
    expect(rung.action).toBe('margin-call');
  });

  it('will NOT liquidate while the grace period is still running', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('9000'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      // Called one minute ago; grace is an hour.
      marginCalledAt: new Date(now.getTime() - 60_000),
    });
    expect(rung.action).toBe('margin-call');
  });

  it('liquidates once the call has been raised AND its grace has expired', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('9000'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: new Date(now.getTime() - 2 * 3_600_000),
    });
    expect(rung.action).toBe('liquidate');
    if (rung.action !== 'liquidate') throw new Error('unreachable');
    expect(rung.graceWaived).toBe(false);
  });

  /**
   * THE ONE EXCEPTION, AND IT IS RECORDED AS ONE.
   *
   * Past the insolvency threshold, waiting out grace guarantees the loss lands on
   * the reserve — which is to say on every other borrower and depositor, none of
   * whom chose this leverage. Grace is waived, and `graceWaived` is set so the
   * one case that breaks the ordering rule is auditable per event rather than
   * inferred later.
   */
  it('waives grace past the insolvency threshold, and says so', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('9600'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: null,
    });
    expect(rung.action).toBe('liquidate');
    if (rung.action !== 'liquidate') throw new Error('unreachable');
    expect(rung.graceWaived).toBe(true);
  });

  /**
   * THE PARTIAL LADDER.
   *
   * The derivatives spec insists on partial liquidation before an insurance fund
   * because selling a whole position into a thin book moves the price against the
   * seller — manufacturing exactly the bad debt the liquidation was meant to
   * prevent. The same reasoning transfers here, and arguably harder: loan
   * collateral is one spot asset with no offsetting position anywhere.
   */
  it('sells only what restores the target LTV, not the whole position', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('9000'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: new Date(now.getTime() - 2 * 3_600_000),
    });
    if (rung.action !== 'liquidate') throw new Error('expected a liquidation');

    // Far short of the whole 1 BTC.
    expect(rung.collateralToSell).toBeLessThan(amt('1'));
    expect(rung.closesPosition).toBe(false);
  });

  it('caps one rung at maxTrancheBps of the remaining collateral, whatever the arithmetic asks for', () => {
    const rung = planLiquidation({
      ...base,
      // Deeply underwater: the unconstrained algebra would sell everything.
      debt: amt('9900'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: new Date(now.getTime() - 2 * 3_600_000),
      policy: { ...DEFAULT_LIQUIDATION_POLICY, maxTrancheBps: 2_500 },
    });
    if (rung.action !== 'liquidate') throw new Error('expected a liquidation');
    expect(rung.collateralToSell).toBe(amt('0.25'));
  });

  it('rounds the sale DOWN — the smallest tranche that reaches the target', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('8600'),
      collateral: amt('1'),
      collateralMark: mark('10000'),
      marginCalledAt: new Date(now.getTime() - 2 * 3_600_000),
    });
    if (rung.action !== 'liquidate') throw new Error('expected a liquidation');

    // Selling exactly this much must NOT overshoot below the target.
    const proceeds = (rung.collateralToSell * amt('10000')) / amt('1');
    const debtAfter = amt('8600') - proceeds;
    const collateralAfter = amt('1') - rung.collateralToSell;
    const ltvAfter = ltvBps(debtAfter, (collateralAfter * amt('10000')) / amt('1'));
    expect(ltvAfter).toBeGreaterThanOrEqual(DEFAULT_LIQUIDATION_POLICY.targetLtvBps);
  });

  /**
   * A broken price feed is not a cheap asset, and dividing by it decides how much
   * of someone's collateral to sell.
   */
  it('refuses to plan against a zero or negative mark', () => {
    expect(() =>
      planLiquidation({
        ...base,
        debt: amt('9000'),
        collateral: amt('1'),
        collateralMark: { assetId: 'BTC', price: 0n, asOf: now, quality: 'mid' },
        marginCalledAt: new Date(now.getTime() - 2 * 3_600_000),
      }),
    ).toThrow(RiskError);
  });

  it('does not keep laddering once the collateral is gone', () => {
    const rung = planLiquidation({
      ...base,
      debt: amt('1000'),
      collateral: 0n,
      collateralMark: mark('10000'),
      marginCalledAt: new Date(now.getTime() - 2 * 3_600_000),
    });
    expect(rung.action).toBe('none');
  });
});

describe('isMarginCallCured — full coll sale must not false-cure', () => {
  const calledAt = new Date('2026-06-01T11:00:00Z');

  it('clears a real recovery (LTV back below threshold with collateral held)', () => {
    expect(
      isMarginCallCured({
        ladderAction: 'none',
        debt: amt('5000'),
        collateral: amt('1'),
        marginCalledAt: calledAt,
      }),
    ).toBe(true);
  });

  it('does NOT clear when collateral is gone and residual debt remains', () => {
    // The residual is typically unpaid interest after a closing sale whose
    // proceeds paid some interest then booked principal shortfall to insurance.
    // Reporting this as cured `active` is the honesty bug.
    expect(
      isMarginCallCured({
        ladderAction: 'none',
        debt: amt('40'), // residual interest
        collateral: 0n,
        marginCalledAt: calledAt,
      }),
    ).toBe(false);
  });

  it('does not clear when the ladder still wants a margin call or liquidation', () => {
    expect(
      isMarginCallCured({
        ladderAction: 'margin-call',
        debt: amt('5000'),
        collateral: amt('1'),
        marginCalledAt: calledAt,
      }),
    ).toBe(false);
  });

  it('does not clear a loan that was never called', () => {
    expect(
      isMarginCallCured({
        ladderAction: 'none',
        debt: amt('5000'),
        collateral: amt('1'),
        marginCalledAt: null,
      }),
    ).toBe(false);
  });
});

describe('the proceeds waterfall', () => {
  it('pays penalty, then interest, then principal, then the borrower', () => {
    const split = splitProceeds({
      proceeds: amt('1000'),
      interestOwed: amt('50'),
      principalOwed: amt('500'),
      penaltyBps: 200,
      closesPosition: true,
    });

    expect(formatAmount(split.penalty)).toBe('20');
    expect(formatAmount(split.interestRepaid)).toBe('50');
    expect(formatAmount(split.principalRepaid)).toBe('500');
    expect(formatAmount(split.surplusToBorrower)).toBe('430');
    expect(split.shortfall).toBe(0n);

    // EVERY UNIT IS ALLOCATED. An unallocated remainder is value the borrower's
    // collateral produced that nobody has claimed.
    expect(split.penalty + split.interestRepaid + split.principalRepaid + split.surplusToBorrower).toBe(amt('1000'));
  });

  /**
   * THE SURPLUS IS THE BORROWER'S.
   *
   * The stub this design replaces credited the ENTIRE seizure to `houseFees`.
   * Keeping the overshoot on a forced sale is taking money that is not the
   * platform's, on the one day the borrower is least able to argue about it.
   */
  it('returns the surplus to the borrower rather than keeping it', () => {
    const split = splitProceeds({
      proceeds: amt('10000'),
      interestOwed: amt('0'),
      principalOwed: amt('1000'),
      penaltyBps: 200,
      closesPosition: true,
    });
    expect(split.surplusToBorrower).toBeGreaterThan(amt('8000'));
  });

  /**
   * A penalty taken out of a short recovery is a transfer from depositors to the
   * house: the reserve is already not getting its principal back, and the fee
   * would come out of what little did come back.
   */
  it('never takes a penalty out of the lender&apos;s recovery on a short sale', () => {
    const split = splitProceeds({
      proceeds: amt('400'),
      interestOwed: amt('50'),
      principalOwed: amt('1000'),
      penaltyBps: 200,
      closesPosition: true,
    });
    expect(split.penalty).toBe(0n);
    expect(formatAmount(split.interestRepaid)).toBe('50');
    expect(formatAmount(split.principalRepaid)).toBe('350');
    expect(formatAmount(split.shortfall)).toBe('650');
    expect(split.surplusToBorrower).toBe(0n);
  });

  /**
   * A shortfall on a rung that leaves collateral behind is not a loss yet — the
   * next rung may cover it. Only a CLOSING rung crystallises bad debt.
   */
  it('does not crystallise a shortfall while there are rungs left', () => {
    const split = splitProceeds({
      proceeds: amt('100'),
      interestOwed: 0n,
      principalOwed: amt('1000'),
      penaltyBps: 200,
      closesPosition: false,
    });
    expect(split.shortfall).toBe(0n);
    expect(formatAmount(split.principalRepaid)).toBe('100');
  });

  /**
   * Shortfall is PRINCIPAL-only. Interest is paid first in the waterfall; when
   * proceeds cannot cover interest, the unpaid interest is NOT folded into
   * `shortfall` (that field feeds `loanBadDebt` → insurance → reserve, and
   * interest never sat on the reserve). Residual interest is a real claim that
   * must not be silently cured away after a full collateral sale.
   */
  it('does not book unpaid interest as reserve shortfall on a closing sale', () => {
    const split = splitProceeds({
      proceeds: amt('10'),
      interestOwed: amt('50'),
      principalOwed: amt('1000'),
      penaltyBps: 200,
      closesPosition: true,
    });
    expect(formatAmount(split.interestRepaid)).toBe('10');
    expect(split.principalRepaid).toBe(0n);
    expect(formatAmount(split.shortfall)).toBe('1000'); // principal only
    // 40 of interest remains uncollected — not in shortfall.
    expect(split.interestRepaid + split.principalRepaid + split.penalty + split.surplusToBorrower).toBe(amt('10'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3 · MARK GUARDS — a stale or printed price must not seize anybody's collateral.
// ═══════════════════════════════════════════════════════════════════════════════

describe('mark acceptability', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const at = (secondsAgo: number, quality: QuotedMark['quality'] = 'mid', price = '10000'): QuotedMark => ({
    assetId: 'BTC',
    price: amt(price),
    asOf: new Date(now.getTime() - secondsAgo * 1_000),
    quality,
  });

  it('accepts a fresh two-sided mark for both marking and liquidation', () => {
    expect(acceptableForMarking(at(5), now, DEFAULT_MARK_POLICY).ok).toBe(true);
    expect(acceptableForLiquidation(at(5), null, now, DEFAULT_MARK_POLICY).ok).toBe(true);
  });

  /**
   * ASYMMETRIC ON PURPOSE. Refusing to WARN on a 90-second-old mark leaves the
   * borrower uninformed. Refusing to SELL on it leaves them with their collateral.
   */
  it('tolerates a stale mark for a warning but not for a seizure', () => {
    expect(acceptableForMarking(at(120), now, DEFAULT_MARK_POLICY).ok).toBe(true);
    expect(acceptableForLiquidation(at(120), null, now, DEFAULT_MARK_POLICY).ok).toBe(false);
  });

  it('refuses a mark from the future — a clock problem is how a stale price passes a staleness check', () => {
    expect(acceptableForMarking(at(-120), now, DEFAULT_MARK_POLICY).ok).toBe(false);
  });

  it('refuses a non-positive mark outright', () => {
    expect(acceptableForMarking({ assetId: 'BTC', price: 0n, asOf: now, quality: 'mid' }, now, DEFAULT_MARK_POLICY).ok).toBe(false);
  });

  /**
   * THE ORACLE-MANIPULATION DEFENCE.
   *
   * svc-trade has no index price — only best bid/ask and last trade. On a thin
   * book one small sell prints a low `last`, every loan collateralised by that
   * asset marks down at once, and liquidations fire at a price nobody could have
   * got size at. So `last` is not a liquidation basis.
   */
  it('will NOT liquidate on a mark derived from a single trade print', () => {
    const check = acceptableForLiquidation(at(5, 'last'), null, now, DEFAULT_MARK_POLICY);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/single print must not seize collateral/);
  });

  it('will still WARN on a last-trade mark — a notification costs the borrower nothing', () => {
    expect(acceptableForMarking(at(5, 'last'), now, DEFAULT_MARK_POLICY).ok).toBe(true);
  });

  /** The circuit breaker. A genuine crash liquidates one interval later; a spoofed print never does. */
  it('refuses to liquidate through a mark that moved further than the breaker allows', () => {
    const check = acceptableForLiquidation(at(5, 'mid', '5000'), amt('10000'), now, DEFAULT_MARK_POLICY);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/breaker/);
  });

  it('allows a move inside the breaker', () => {
    expect(acceptableForLiquidation(at(5, 'mid', '9000'), amt('10000'), now, DEFAULT_MARK_POLICY).ok).toBe(true);
  });

  it('computes the deviation in integer bps, not floating point', () => {
    // Exactly on the breaker trips it: 2000bps from 10000 is 8000.
    expect(acceptableForLiquidation(at(5, 'mid', '8000'), amt('10000'), now, DEFAULT_MARK_POLICY).ok).toBe(true);
    expect(acceptableForLiquidation(at(5, 'mid', '7999'), amt('10000'), now, DEFAULT_MARK_POLICY).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4 · THE RECIPES — what the ledger will and will not accept.
// ═══════════════════════════════════════════════════════════════════════════════

describe('loan recipes', () => {
  let ledger: MemoryLedger;

  beforeEach(() => {
    ledger = new MemoryLedger();
  });

  const fund = async (userId: string, assetId: string, value: string) =>
    ledger.post(recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${Math.random()}` }));

  const fundReserve = async (assetId: string, value: string) => {
    const payer = '99999999-9999-4999-8999-999999999999';
    await fund(payer, assetId, value);
    await ledger.post(
      recipes.feeCharge({ chargeId: `bank:${Math.random()}`, userId: payer, module: 'bank', mode: 'asset', assetId, amount: amt(value) }),
    );
    await ledger.post(recipes.loanReserveFund({ fundingId: `f:${Math.random()}`, debtAssetId: assetId, amount: amt(value) }));
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * P0-3, EXTENDED TO `collateral`. THE BUG THAT WAS STILL OPEN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `client.ts` used to say "`collateral` remains open until a futures claim key
   * is designed". Until it was closed there was ONE collateral pot per (user,
   * asset), so a borrower with two BTC-backed loans had both secured by the same
   * balance: releasing loan A's collateral could hand back value securing loan B,
   * with every posting balancing and the journal reconciling perfectly.
   */
  it('keeps two loans&apos; collateral in separate pots, so releasing one cannot unsecure the other', async () => {
    await fund(BORROWER, 'BTC', '2');

    await ledger.post(
      recipes.loanCollateralLock({ loanId: 'loan-a', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 }),
    );
    await ledger.post(
      recipes.loanCollateralLock({ loanId: 'loan-b', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 }),
    );

    // Two accounts, one per loan. Not one pot with two claims on it.
    const a = await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'loan-a'));
    const b = await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'loan-b'));
    expect(formatAmount(a.amount)).toBe('1');
    expect(formatAmount(b.amount)).toBe('1');

    // Releasing A drains A and leaves B untouched.
    await ledger.post(
      recipes.loanCollateralRelease({ loanId: 'loan-a', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 1 }),
    );
    expect(formatAmount((await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'loan-a'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'loan-b'))).amount)).toBe('1');

    // And A cannot be released twice, because there is nothing left in ITS pot —
    // it can no longer reach B's. Before the purpose key this succeeded.
    await expect(
      ledger.post(
        recipes.loanCollateralRelease({ loanId: 'loan-a', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 2 }),
      ),
    ).rejects.toThrow(/[Ii]nsufficient/);
  });

  it('refuses an unpurposed collateral account at the constructor and at the invariant', async () => {
    expect(() => userCollateral(BORROWER, 'BTC', '')).toThrow(/requires a purpose/);

    await fund(BORROWER, 'BTC', '1');
    await expect(
      ledger.post({
        idempotencyKey: 'handmade-unpurposed-lock',
        module: 'bank',
        reason: 'test',
        entries: [
          { account: userAvailable(BORROWER, 'BTC'), direction: 'credit', amount: amt('1') },
          { account: { ownerType: 'user', ownerId: BORROWER, assetId: 'BTC', kind: 'collateral' }, direction: 'debit', amount: amt('1') },
        ],
      }),
    ).rejects.toThrow(/no purpose/);
  });

  /**
   * ORDERING. Collateral is locked from the borrower's OWN available balance, in
   * the same transaction — `assertPairedLocks` proves it — so locked collateral
   * is provably still the borrower's rather than something the platform took.
   */
  it('funds a collateral lock from the borrower&apos;s own available balance and nowhere else', async () => {
    await fund(BORROWER, 'BTC', '0.5');
    await expect(
      ledger.post(recipes.loanCollateralLock({ loanId: 'l1', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 })),
    ).rejects.toThrow(/[Ii]nsufficient/);
  });

  /**
   * THE RESERVE IS HARD NON-NEGATIVE. A `module` account cannot go below zero
   * (§4.2's database CHECK), so an under-funded reserve cannot lend — it fails,
   * loudly. Drawing against a `treasury` boundary instead would produce a book
   * indistinguishable from one where the platform had printed the principal.
   */
  it('cannot lend principal the reserve does not have', async () => {
    await fund(BORROWER, 'BTC', '1');
    await ledger.post(
      recipes.loanCollateralLock({ loanId: 'l1', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 }),
    );

    await expect(
      ledger.post(recipes.loanDraw({ loanId: 'l1', userId: BORROWER, debtAssetId: 'USDT', principal: amt('5000') })),
    ).rejects.toThrow(/[Ii]nsufficient/);
  });

  it('moves principal from the reserve to the borrower, and back on repayment', async () => {
    await fundReserve('USDT', '10000');
    await fund(BORROWER, 'BTC', '1');

    await ledger.post(
      recipes.loanCollateralLock({ loanId: 'l1', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 }),
    );
    await ledger.post(recipes.loanDraw({ loanId: 'l1', userId: BORROWER, debtAssetId: 'USDT', principal: amt('5000') }));

    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('5000');

    await ledger.post(
      recipes.loanRepay({ loanId: 'l1', userId: BORROWER, debtAssetId: 'USDT', principal: amt('5000'), interest: 0n, sequence: 0 }),
    );

    // Principal is back in the reserve, lendable again.
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('10000');
    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('0');
  });

  it('splits a repayment: principal to the reserve, interest to bank revenue', async () => {
    await fundReserve('USDT', '10000');
    await fund(BORROWER, 'USDT', '100');
    await ledger.post(recipes.loanDraw({ loanId: 'l1', userId: BORROWER, debtAssetId: 'USDT', principal: amt('1000') }));

    const houseBefore = (await ledger.balance(houseFees('bank', 'USDT'))).amount;

    await ledger.post(
      recipes.loanRepay({ loanId: 'l1', userId: BORROWER, debtAssetId: 'USDT', principal: amt('1000'), interest: amt('50'), sequence: 0 }),
    );

    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('10000');
    expect((await ledger.balance(houseFees('bank', 'USDT'))).amount - houseBefore).toBe(amt('50'));
  });

  /**
   * ONE TRANSACTION. The three-step version — release, sell, apply — has a window
   * in which the borrower holds spendable collateral on a defaulting loan, and a
   * borrower watching a liquidation notices. Here the collateral goes from the
   * borrower's purposed pot straight to the buyer, and the buyer really pays, in
   * the same posting.
   */
  it('seizes, sells and repays atomically across two assets', async () => {
    await fundReserve('USDT', '10000');
    await fund(BORROWER, 'BTC', '1');
    await fund(MM_FUNDER, 'USDT', '20000');

    // The market maker must actually hold cash to buy with.
    await ledger.post({
      idempotencyKey: 'seed-market-maker',
      module: 'test',
      reason: 'seed',
      entries: [
        { account: userAvailable(MM_FUNDER, 'USDT'), direction: 'credit', amount: amt('20000') },
        { account: marketMaker('USDT'), direction: 'debit', amount: amt('20000') },
      ],
    });

    await ledger.post(
      recipes.loanCollateralLock({ loanId: 'l1', userId: BORROWER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 }),
    );
    await ledger.post(recipes.loanDraw({ loanId: 'l1', userId: BORROWER, debtAssetId: 'USDT', principal: amt('5000') }));

    await ledger.post(
      recipes.loanLiquidate({
        loanId: 'l1',
        userId: BORROWER,
        tranche: 0,
        collateralAssetId: 'BTC',
        collateralSold: amt('0.6'),
        debtAssetId: 'USDT',
        proceeds: amt('6000'),
        principalRepaid: amt('5000'),
        interestRepaid: amt('100'),
        penalty: amt('120'),
        surplusToBorrower: amt('780'),
        buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
        markPrice: amt('10000'),
      }),
    );

    // Collateral went to the buyer; the borrower's remaining pot is untouched.
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('0.6');
    expect(formatAmount((await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'l1'))).amount)).toBe('0.4');
    // The reserve is whole again.
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('10000');
    // And the surplus went BACK TO THE BORROWER, not to the house.
    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5780');
  });

  it('refuses a liquidation whose proceeds are not fully allocated', () => {
    expect(() =>
      recipes.loanLiquidate({
        loanId: 'l1',
        userId: BORROWER,
        tranche: 0,
        collateralAssetId: 'BTC',
        collateralSold: amt('1'),
        debtAssetId: 'USDT',
        proceeds: amt('6000'),
        principalRepaid: amt('5000'),
        interestRepaid: 0n,
        penalty: 0n,
        surplusToBorrower: 0n, // 1000 unaccounted for
        buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
        markPrice: amt('10000'),
      }),
    ).toThrow(/fully allocated/);
  });

  /**
   * THE LADDER NEEDS MORE THAN ONE RUNG, AND THE OLD KEY FORBADE IT.
   *
   * The recipe this replaces keyed on `bank.liquidate:<loanId>` — one liquidation
   * per loan for all time. Two rungs must be two transactions.
   */
  it('gives each tranche its own idempotency key, so a ladder is expressible', () => {
    const shared = {
      loanId: 'l1',
      userId: BORROWER,
      collateralAssetId: 'BTC',
      collateralSold: amt('0.1'),
      debtAssetId: 'USDT',
      proceeds: amt('1000'),
      principalRepaid: amt('1000'),
      interestRepaid: 0n,
      penalty: 0n,
      surplusToBorrower: 0n,
      buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
      markPrice: amt('10000'),
    };
    const first = recipes.loanLiquidate({ ...shared, tranche: 0 });
    const second = recipes.loanLiquidate({ ...shared, tranche: 1 });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(second.idempotencyKey).toContain(':1');
  });

  it('refuses a same-asset liquidation, which would post a fictional trade', () => {
    expect(() =>
      recipes.loanLiquidate({
        loanId: 'l1',
        userId: BORROWER,
        tranche: 0,
        collateralAssetId: 'USDT',
        collateralSold: amt('1'),
        debtAssetId: 'USDT',
        proceeds: amt('1'),
        principalRepaid: amt('1'),
        interestRepaid: 0n,
        penalty: 0n,
        surplusToBorrower: 0n,
        buyer: { collateralTo: marketMaker('USDT'), proceedsFrom: marketMaker('USDT') },
        markPrice: amt('1'),
      }),
    ).toThrow(InvalidEntryError);
  });

  /** The loss has a name and an owner, and when nobody can cover it the post fails. */
  it('books bad debt against the insurance fund, and fails loudly when it is empty', async () => {
    await fundReserve('USDT', '10000');
    await expect(ledger.post(recipes.loanBadDebt({ loanId: 'l1', debtAssetId: 'USDT', shortfall: amt('500') }))).rejects.toThrow(
      /[Ii]nsufficient/,
    );

    // Fund the insurance fund and it works, moving the loss where it belongs.
    await fund(INSURANCE_FUNDER, 'USDT', '1000');
    await ledger.post({
      idempotencyKey: 'seed-insurance-fund',
      module: 'test',
      reason: 'seed',
      entries: [
        { account: userAvailable(INSURANCE_FUNDER, 'USDT'), direction: 'credit', amount: amt('1000') },
        { account: insuranceFund('USDT'), direction: 'debit', amount: amt('1000') },
      ],
    });

    await ledger.post(recipes.loanBadDebt({ loanId: 'l1', debtAssetId: 'USDT', shortfall: amt('500') }));
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('500');
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('10500');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5 · THE SERVICE — ordering, crash points, and the accrual guard, on Postgres.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The service's SQL is schema-qualified (`bank.loans`) on purpose, so
 * `createTestDb`'s per-run schema cannot isolate it — the same reason
 * `bank-service.test.ts` gives. The isolation is therefore a whole DATABASE,
 * not a schema: a real `bank` schema in a database nothing else connects to.
 *
 * That much was already true. What it was NOT is per-run.
 * `intafaced_bank_loans_test` is one fixed database, so "nothing else in the
 * platform connects to it" quietly meant "nothing except this same suite
 * running in another of the ~85 worktrees" — which truncates `bank.loans`
 * in `beforeEach` exactly as destructively as the shared database did. Two
 * checkouts running this file at once failed 25 and 23 tests respectively.
 *
 * `createTestDatabase` makes the database per-run rather than merely dedicated.
 * The migrations below are applied verbatim to a database that did not exist a
 * moment ago, which also retires the `IF NOT EXISTS` dance: they were guarded
 * because a fixed database is only migrated once, and a fresh one is migrated
 * exactly once by construction.
 */
const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-bank loans is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-bank loans (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-bank loans PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({
      service: 'bank',
      url: admin.url,
      migrations: [
        BANK_INIT,
        POSITION_PENDING,
        LOANS_MIGRATION,
        OPENING_COLLATERAL,
        RESERVE_FUNDINGS,
        SETTLED_HAS_TX,
        OPS_READS,
        INTEREST_CORRECTIONS,
      ],
    });
    sql = db.sql;
  }, 120_000);

  /** 30s: dropping a database is heavier than closing a pool. See bank-service.test.ts. */
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('LoanService', () => {
    let ledger: MemoryLedger;
    let loans: LoanService;
    let calls: Array<{ loanId: string; ltvBps: number }>;
    let now: Date;
    let markNow: Date;

    /**
     * Marks are stamped at `markNow`, which the tests advance in step with the
     * clock they pass to the sweep. A source pinned to wall time would hand back
     * marks two months in the future of a fixed test instant, and the staleness
     * guard would correctly reject every one of them — failing the suite for a
     * reason that has nothing to do with what it is testing.
     */
    const price = (btc: string) => fixedPriceSource({ BTC: { price: btc, quality: 'mid' } }, () => markNow);

    /** Advance the clock and the marks together, then sweep. */
    const sweepAt = async (at: Date) => {
      markNow = at;
      return loans.runRiskSweep({ now: at, limit: 500 });
    };

    async function fund(userId: string, assetId: string, value: string) {
      await ledger.post(
        recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${Math.random()}` }),
      );
    }

    async function fundReserve(assetId: string, value: string) {
      const payer = '99999999-9999-4999-8999-999999999999';
      await fund(payer, assetId, value);
      // Fund through the service so the independent funding table records it
      // (B-02). Direct ledger-only fundings would leave reconcile drift ≠ 0.
      await loans.fundReserve({
        debtAssetId: assetId,
        fundingId: `f:${Math.random()}`,
        amount: amt(value),
        from: userAvailable(payer, assetId),
      });
    }

    async function makeProduct(overrides: Partial<Parameters<LoanService['createProduct']>[0]> = {}) {
      return loans.createProduct({
        name: 'BTC-backed USDT',
        debtAssetId: 'USDT',
        collateralAssetId: 'BTC',
        quoteAssetId: 'USDT',
        aprBps: 1_000,
        maxLtvBps: 5_000,
        minPrincipal: 0n,
        policy: DEFAULT_LIQUIDATION_POLICY,
        ...overrides,
      });
    }

    /** Move a loan's last-attempt time back, on the database clock. */
    async function ageLastAttempt(loanId: string, seconds: number) {
      await sql`UPDATE bank.loans SET updated_at = now() - (${seconds}::int * interval '1 second') WHERE id = ${loanId}`;
    }

    beforeEach(async () => {
      await sql`
        TRUNCATE bank.loan_liquidations, bank.loan_margin_calls, bank.loan_repayments,
                 bank.loan_interest_accruals, bank.loan_collateral_events, bank.loans, bank.loan_products,
                 bank.loan_reserve_fundings
        RESTART IDENTITY CASCADE
      `;
      ledger = new MemoryLedger();
      calls = [];
      now = new Date('2026-06-01T12:00:00Z');
      markNow = now;

      const sink: MarginCallSink = {
        send: async (input) => {
          calls.push({ loanId: input.loanId, ltvBps: input.ltvBps });
        },
      };

      loans = new LoanService(sql, ledger, {
        originationFeeBps: '0',
        priceSource: price('10000'),
        marginCalls: sink,
        venue: marketMakerVenue(),
      });
    });

    // ── The happy path, and the ordering inside it ────────────────────────────

    it('locks collateral BEFORE releasing principal', async () => {
      await fundReserve('USDT', '100000');
      await fund(BORROWER, 'BTC', '1');
      const product = await makeProduct();

      const result = await loans.open({
        productId: product.id,
        userId: BORROWER,
        collateralAmount: amt('1'),
        principal: amt('5000'),
        now,
      });

      expect(result.loan.status).toBe('active');
      expect(result.ltvBps).toBe(5_000);

      // The ledger's own ordering: both postings exist, and the collateral one
      // came first.
      const events = await sql`SELECT direction, sequence, status FROM bank.loan_collateral_events WHERE loan_id = ${result.loan.id}`;
      expect(events).toHaveLength(1);
      expect(events[0]!.direction).toBe('lock');
      expect(events[0]!.status).toBe('settled');

      expect(formatAmount(await loans.collateralOf(result.loan))).toBe('1');
      expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
      expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('0');
    });

    it('refuses a draw that would open above the product&apos;s maximum LTV', async () => {
      await fundReserve('USDT', '100000');
      await fund(BORROWER, 'BTC', '1');
      const product = await makeProduct();

      await expect(
        loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('6000'), now }),
      ).rejects.toThrow(/exceeds the/);
    });

    /**
     * Underfunded `loanReserve` must refuse the draw. The reserve is a module
     * account (hard non-negative); inventing the shortfall would be printing.
     * Existing product LTV / APR — no invented rates.
     */
    it('refuses an underfunded loanReserve draw rather than printing principal', async () => {
      await fundReserve('USDT', '1000');
      await fund(BORROWER, 'BTC', '1');
      const product = await makeProduct();

      await expect(
        loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now }),
      ).rejects.toMatchObject({ code: 'bank.loan_reserve_underfunded' });

      expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('1000');
      expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('0');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * "SAME TERMS" HAS TO INCLUDE WHO IS ASKING
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * `bank.loan_principal_mismatch` below already refuses a retry that changes
     * the AMOUNT, on exactly the right reasoning: `ON CONFLICT (id) DO NOTHING`
     * makes the service read back the first call's row while every guard ran on
     * the new input. That reasoning did not reach the borrower.
     *
     * With the principal held equal, a second caller reusing the id was told
     * "your loan is open" — a status, an LTV, and two ledger transaction ids —
     * with no collateral of theirs locked and no principal of theirs drawn.
     * On the `pending` branch it is not merely a wrong answer: the second
     * caller's collateral FIGURE drives the first borrower's loan, out of the
     * first borrower's account.
     */
    describe('a loan id belonging to another borrower', () => {
      it('refuses the second borrower, and draws nothing for them', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        await fund(OTHER, 'BTC', '1');
        const product = await makeProduct();
        const loanId = '6f000000-0000-4000-8000-00000000dddd';

        await loans.open({ loanId, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now });

        await expect(
          loans.open({ loanId, productId: product.id, userId: OTHER, collateralAmount: amt('1'), principal: amt('5000'), now }),
        ).rejects.toMatchObject({ code: 'bank.loan_borrower_mismatch' });

        // OTHER borrowed nothing and pledged nothing — the state they are in is
        // the state they were in before the call.
        expect(formatAmount((await ledger.balance(userAvailable(OTHER, 'USDT'))).amount)).toBe('0');
        expect(formatAmount((await ledger.balance(userAvailable(OTHER, 'BTC'))).amount)).toBe('1');
        expect(await loans.loansOf(OTHER, 50)).toHaveLength(0);
      });

      it('refuses the second borrower on a loan still stuck pending, leaving the first one alone', async () => {
        await fund(BORROWER, 'BTC', '1');
        await fund(OTHER, 'BTC', '5');
        const product = await makeProduct();
        const loanId = '6f000000-0000-4000-8000-00000000eeee';

        // Reserve empty: the draw fails and the loan is left `pending` with the
        // borrower's collateral locked — the documented crash window above.
        await loans
          .open({ loanId, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);
        await fundReserve('USDT', '100000');

        await expect(
          loans.open({ loanId, productId: product.id, userId: OTHER, collateralAmount: amt('5'), principal: amt('5000'), now }),
        ).rejects.toMatchObject({ code: 'bank.loan_borrower_mismatch' });

        // The first borrower's collateral is still the ONE they pledged, not the
        // five the second caller named, and the second caller still has theirs.
        const loan = await loans.loan(loanId);
        expect(loan.userId).toBe(BORROWER);
        expect(formatAmount(await loans.collateralOf(loan))).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(OTHER, 'BTC'))).amount)).toBe('5');
      });
    });

    it('refuses a loan id reused by the same borrower for a different product', async () => {
      await fundReserve('USDT', '100000');
      await fund(BORROWER, 'BTC', '1');
      const firstProduct = await makeProduct({ name: 'First BTC-backed USDT' });
      const otherProduct = await makeProduct({ name: 'Other BTC-backed USDT' });
      const loanId = '6f000000-0000-4000-8000-00000000eeef';

      const opened = await loans.open({
        loanId,
        productId: firstProduct.id,
        userId: BORROWER,
        collateralAmount: amt('1'),
        principal: amt('5000'),
        now,
      });

      await expect(
        loans.open({
          loanId,
          productId: otherProduct.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        }),
      ).rejects.toMatchObject({ code: 'bank.loan_borrower_mismatch' });

      expect(opened.loan.productId).toBe(firstProduct.id);
      expect(formatAmount(await loans.collateralOf(opened.loan))).toBe('1');
      expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * IF THE PROCESS DIES BETWEEN THE LOCK AND THE DRAW, WHOSE FUNDS ARE STRANDED?
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * Nobody's, and this is the proof. The reserve is deliberately left empty so
     * the draw fails exactly where a crash would have landed. The collateral is
     * locked, the borrower has no principal, and the loan is `pending`.
     *
     * Two recoveries, both exercised: fund the reserve and re-drive, or abandon
     * and give the collateral back. Either way the borrower ends whole.
     */
    describe('the crash window between locking collateral and releasing principal', () => {
      it('leaves the collateral in the borrower&apos;s OWN account with the reserve untouched', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();

        await expect(
          loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now }),
        ).rejects.toThrow(BankError);

        const rows = await sql<Array<{ id: string; status: string }>>`SELECT id, status FROM bank.loans`;
        expect(rows[0]!.status).toBe('pending');

        const loan = await loans.loan(rows[0]!.id);
        // The value is in a `user`-owned account, purposed to this loan.
        expect(formatAmount(await loans.collateralOf(loan))).toBe('1');
        // The reserve never moved, and the borrower has no principal.
        expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('0');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('0');
      });

      it('recovers by re-driving once the reserve is funded — locking collateral exactly once', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);

        await fundReserve('USDT', '100000');
        const resumed = await loans.resumePending(100, now);

        expect(resumed).toHaveLength(1);
        expect(resumed[0]!.outcome).toBe('completed');

        const rows = await sql<Array<{ id: string; status: string }>>`SELECT id, status FROM bank.loans`;
        const loan = await loans.loan(rows[0]!.id);
        expect(loan.status).toBe('active');

        // THE COLLATERAL WAS NOT LOCKED TWICE. The lock's idempotency key is
        // (loan, sequence 0), so re-driving finds the original transaction.
        expect(formatAmount(await loans.collateralOf(loan))).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
      });

      /**
       * ═══════════════════════════════════════════════════════════════════════
       * A RETRY MUST CARRY THE SAME TERMS, OR IT IS A DIFFERENT LOAN
       * ═══════════════════════════════════════════════════════════════════════
       *
       * The crash window above is safe because the retry re-drives the SAME
       * loan. That is only true while the retry asks for the same thing.
       *
       * `ON CONFLICT (id) DO NOTHING` means a retry writes nothing and the
       * service reads back the FIRST call's row — with the FIRST call's
       * principal. Every guard above it ran on the NEW input. `completePending`
       * then locks the new collateral and draws the old principal, and nothing
       * reconciled the two.
       *
       * So: fail an enormous loan for want of collateral, then retry the same
       * id for a trivial amount you can actually cover. The LTV check passes on
       * the trivial numbers; the payout uses the enormous stored one. Repeat
       * until the lending reserve is empty.
       */
      it('refuses a retry that changes the principal, instead of drawing the stored one', async () => {
        const product = await makeProduct();
        await fundReserve('USDT', '100000');
        const loanId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

        // 1. Ask for 5 000 against 1 BTC the borrower does not hold. LTV passes,
        //    the row persists at 5 000, the collateral lock fails, loan pending.
        await expect(
          loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), loanId, now }),
        ).rejects.toThrow(BankError);

        const pending = await sql<
          Array<{ status: string; principal: string }>
        >`SELECT status, principal FROM bank.loans WHERE id = ${loanId}`;
        expect(pending[0]!.status).toBe('pending');

        // 2. Now hold a little real collateral and retry the SAME id for 1 USDT.
        await fund(BORROWER, 'BTC', '0.01');

        await expect(
          loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('0.01'), principal: amt('1'), loanId, now }),
        ).rejects.toMatchObject({ code: 'bank.loan_principal_mismatch' });

        // The reserve never moved and the borrower drew nothing.
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('0');
        expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('100000');
      });

      /**
       * Hold principal equal and shrink the collateral on the retry: LTV is
       * re-checked on the dust pledge while the draw still pays the stored
       * principal. Same family as principal_mismatch — "same terms" includes
       * the opening pledge amount.
       */
      it('refuses a retry that changes the opening collateral, instead of locking the new amount against the old principal', async () => {
        const product = await makeProduct();
        await fundReserve('USDT', '100000');
        const loanId = '3fa85f64-5717-4562-b3fc-2c963f66afb1';

        // 1. Open for 5 000 against 1 BTC the borrower does not hold. Row
        //    persists with opening_collateral=1; lock fails; pending.
        await expect(
          loans.open({
            productId: product.id,
            userId: BORROWER,
            collateralAmount: amt('1'),
            principal: amt('5000'),
            loanId,
            now,
          }),
        ).rejects.toThrow(BankError);

        const pending = await sql<Array<{ status: string; opening_collateral: string | null }>>`
          SELECT status, opening_collateral::text AS opening_collateral FROM bank.loans WHERE id = ${loanId}
        `;
        expect(pending[0]!.status).toBe('pending');
        expect(formatAmount(amt(pending[0]!.opening_collateral!))).toBe('1');

        // 2. Same principal, DIFFERENT collateral that still clears LTV (2 BTC
        //    at the test mark is under max LTV). Must refuse on term-compare —
        //    not on LTV — or the attack path is not what we claim.
        await fund(BORROWER, 'BTC', '2');
        await expect(
          loans.open({
            productId: product.id,
            userId: BORROWER,
            collateralAmount: amt('2'),
            principal: amt('5000'),
            loanId,
            now,
          }),
        ).rejects.toMatchObject({ code: 'bank.loan_collateral_mismatch' });

        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('0');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('2');
        expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('100000');
      });

      it('refuses a hostile collateral swap after the loan is already active', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        const loanId = '3fa85f64-5717-4562-b3fc-2c963f66afb2';

        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          loanId,
          now,
        });
        expect(opened.loan.status).toBe('active');

        await expect(
          loans.open({
            productId: product.id,
            userId: BORROWER,
            collateralAmount: amt('2'),
            principal: amt('5000'),
            loanId,
            now,
          }),
        ).rejects.toMatchObject({ code: 'bank.loan_collateral_mismatch' });

        // Original position untouched.
        expect(formatAmount(await loans.collateralOf(opened.loan))).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
      });

      it('still lets an unchanged retry re-drive the same loan', async () => {
        // The guard must not cost idempotency, which is the whole point of a
        // caller-supplied loan id.
        const product = await makeProduct();
        await fund(BORROWER, 'BTC', '1');
        const loanId = '3fa85f64-5717-4562-b3fc-2c963f66afa7';

        await loans
          .open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), loanId, now })
          .catch(() => undefined);

        await fundReserve('USDT', '100000');
        const retried = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          loanId,
          now,
        });

        expect(retried.loan.id).toBe(loanId);
        expect(retried.loan.status).toBe('active');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
        // Locked exactly once.
        expect(formatAmount(await loans.collateralOf(retried.loan))).toBe('1');
      });

      it('recovers by abandoning — the collateral goes back to the borrower', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);

        const rows = await sql<Array<{ id: string }>>`SELECT id FROM bank.loans`;
        // The failed draw was a moment ago: the ledger could still commit it, so
        // abandon waits out the in-flight bound (see the recovery block below).
        await ageLastAttempt(rows[0]!.id, LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS + 60);
        const result = await loans.abandonPending(rows[0]!.id);

        expect(formatAmount(result.released)).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('1');
      });

      it('refuses to abandon a loan whose principal has been drawn', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        });

        await expect(loans.abandonPending(opened.loan.id)).rejects.toThrow(/secures drawn principal/);
      });
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * RECOVERY IS LOOKUP-FIRST (docs/adr/2026-10-14-recovery-lookup-first-no-expiry-yet.md)
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * The draw commits and its reply is lost. The loan stays `pending`, the draw
     * is booked, and the borrower holds spendable principal. `abandonPending`
     * used to release the collateral anyway and leave that principal unsecured.
     */
    describe('recovering a pending loan looks the draw up first', () => {
      const LOAN_ID = '6f000000-0000-4000-8000-0000000000a1';

      /** The ledger commits the draw, then the reply is lost. Returns a restore function. */
      function loseDrawReply(): { posts: () => number; restore: () => void } {
        const original = ledger.post.bind(ledger);
        let drawPosts = 0;
        let lost = false;
        ledger.post = async (request) => {
          if (request.idempotencyKey.startsWith('bank.loan.draw:')) drawPosts += 1;
          const receipt = await original(request);
          if (!lost && request.idempotencyKey.startsWith('bank.loan.draw:')) {
            lost = true;
            throw new Error('reply lost after commit');
          }
          return receipt;
        };
        return {
          posts: () => drawPosts,
          restore: () => {
            ledger.post = original;
          },
        };
      }

      async function openWithLostDrawReply() {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        const lossy = loseDrawReply();
        await expect(
          loans.open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now }),
        ).rejects.toThrow('reply lost after commit');
        return { product, lossy };
      }

      it('abandon ADOPTS a booked draw: the loan goes active and the collateral stays locked', async () => {
        const { lossy } = await openWithLostDrawReply();
        expect((await loans.loan(LOAN_ID)).status).toBe('pending');
        // Recent attempt: a booked draw is adopted at ANY age, so the bound is irrelevant.

        const result = await loans.abandonPending(LOAN_ID);

        expect(result).toMatchObject({ released: 0n, ledgerTxId: null, adopted: true });
        expect(result.drawLedgerTxId).toEqual(expect.any(String));
        const loan = await loans.loan(LOAN_ID);
        expect(loan.status).toBe('active');
        expect(loan.drawLedgerTxId).toBe(result.drawLedgerTxId);
        // NEVER released, NEVER marked repaid: the collateral secures the drawn principal.
        expect(formatAmount(await loans.collateralOf(loan))).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('0');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
        expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.loan.collateral.release:'))).toHaveLength(0);
        // The draw was posted once, by the original attempt. Adoption posted nothing.
        expect(lossy.posts()).toBe(1);
        const lock = await sql<Array<{ status: string; ledger_tx_id: string | null }>>`
          SELECT status, ledger_tx_id FROM bank.loan_collateral_events WHERE loan_id = ${LOAN_ID} AND sequence = 0
        `;
        expect(lock[0]!.status).toBe('settled');
        // A second abandon is refused: this loan is active now.
        await expect(loans.abandonPending(LOAN_ID)).rejects.toThrow(/secures drawn principal/);
      });

      it('abandon refuses an UNBOOKED draw whose last attempt is inside the in-flight bound', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        // Reserve empty: the draw is refused, the loan stays pending, collateral locked.
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);

        await expect(loans.abandonPending(LOAN_ID)).rejects.toMatchObject({ code: 'bank.loan_attempt_too_recent' });
        // Just inside the bound: still refused.
        await ageLastAttempt(LOAN_ID, LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS - 30);
        await expect(loans.abandonPending(LOAN_ID)).rejects.toMatchObject({ code: 'bank.loan_attempt_too_recent' });

        const loan = await loans.loan(LOAN_ID);
        expect(loan.status).toBe('pending');
        expect(formatAmount(await loans.collateralOf(loan))).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('0');
      });

      it('abandon RELEASES an unbooked draw once the last attempt is older than the bound', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);
        await ageLastAttempt(LOAN_ID, LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS + 5);

        const result = await loans.abandonPending(LOAN_ID);

        expect(result).toMatchObject({ adopted: false, drawLedgerTxId: null });
        expect(formatAmount(result.released)).toBe('1');
        expect((await loans.loan(LOAN_ID)).status).toBe('repaid');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('1');
      });

      it('every post attempt moves the last-attempt time forward', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);
        await ageLastAttempt(LOAN_ID, LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS + 5);

        // A retry re-drives the draw (reserve still empty, so it fails again) ...
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);

        // ... and that attempt is recent again, so abandon waits.
        await expect(loans.abandonPending(LOAN_ID)).rejects.toMatchObject({ code: 'bank.loan_attempt_too_recent' });
      });

      it('resume ADOPTS a booked draw without posting it again', async () => {
        const { lossy } = await openWithLostDrawReply();

        const resumed = await loans.resumePending(100, now);

        expect(resumed).toEqual([{ loanId: LOAN_ID, outcome: 'completed' }]);
        const loan = await loans.loan(LOAN_ID);
        expect(loan.status).toBe('active');
        expect(formatAmount(await loans.collateralOf(loan))).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
        expect(lossy.posts()).toBe(1);
      });

      it('resume RE-CHECKS the LTV before re-posting a draw: a failed check posts nothing', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);
        await fundReserve('USDT', '100000');

        // BTC crashed while the loan sat pending: 1 BTC at 5200 against a 5000 draw is 96% LTV.
        const crashed = new LoanService(sql, ledger, { originationFeeBps: '0', priceSource: price('5200'), venue: marketMakerVenue() });
        const resumed = await crashed.resumePending(100, now);

        expect(resumed).toHaveLength(1);
        expect(resumed[0]!.outcome).toBe('failed');
        expect(resumed[0]!.reason).toMatch(/Opening LTV/);
        expect((await loans.loan(LOAN_ID)).status).toBe('pending');
        expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.loan.draw:'))).toHaveLength(0);
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('0');
      });

      it('resume refuses a mark older than the price policy before re-posting a draw', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);
        await fundReserve('USDT', '100000');

        // The feed is stuck at a mark stamped two policy windows before "now".
        const stale = new Date(now.getTime() - 2 * DEFAULT_MARK_POLICY.maxAgeSeconds * 1000);
        const stuck = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: fixedPriceSource({ BTC: { price: '10000', quality: 'mid' } }, () => stale),
          venue: marketMakerVenue(),
        });
        const resumed = await stuck.resumePending(100, now);

        expect(resumed[0]!.outcome).toBe('failed');
        expect(resumed[0]!.reason).toMatch(/No usable mark/);
        expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.loan.draw:'))).toHaveLength(0);

        // A fresh mark lets the same loan through.
        const ok = await loans.resumePending(100, now);
        expect(ok[0]!.outcome).toBe('completed');
      });

      it('addCollateral refuses a PENDING loan: a top-up is for a drawn loan', async () => {
        await fund(BORROWER, 'BTC', '2');
        const product = await makeProduct();
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);

        await expect(loans.addCollateral({ loanId: LOAN_ID, eventId: randomUUID(), amount: amt('1'), now })).rejects.toMatchObject({
          code: 'bank.loan_not_drawable',
        });
        // Nothing moved: only the original 1 BTC is locked, the other 1 BTC is still the borrower's.
        expect(formatAmount(await loans.collateralOf(await loans.loan(LOAN_ID)))).toBe('1');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('1');
      });

      it('abandon BLOCKS while a resume is inside its draw post, then sees the loan active', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);
        await fundReserve('USDT', '100000');
        // Old enough that the bound alone would let an abandon through.
        await ageLastAttempt(LOAN_ID, LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS + 60);

        // Park the resume inside its draw post.
        const original = ledger.post.bind(ledger);
        let entered!: () => void;
        const inDraw = new Promise<void>((resolve) => (entered = resolve));
        let open!: () => void;
        const gate = new Promise<void>((resolve) => (open = resolve));
        ledger.post = async (request) => {
          if (request.idempotencyKey.startsWith('bank.loan.draw:')) {
            entered();
            await gate;
          }
          return original(request);
        };

        try {
          const resume = loans.resumePending(100, now);
          await inDraw;

          const abandon = loans.abandonPending(LOAN_ID);
          const settled = Symbol('settled');
          const early = await Promise.race([
            abandon.then(
              () => settled,
              () => settled,
            ),
            new Promise((r) => setTimeout(() => r('blocked'), 500)),
          ]);
          expect(early).toBe('blocked');
          // Nothing was released while the draw was in flight.
          expect(formatAmount(await loans.collateralOf(await loans.loan(LOAN_ID)))).toBe('1');

          open();
          expect(await resume).toEqual([{ loanId: LOAN_ID, outcome: 'completed' }]);
          await expect(abandon).rejects.toThrow(/secures drawn principal/);
        } finally {
          open();
          ledger.post = original;
        }
        expect((await loans.loan(LOAN_ID)).status).toBe('active');
        expect(formatAmount(await loans.collateralOf(await loans.loan(LOAN_ID)))).toBe('1');
      });

      it('resume treats a REJECTED collateral lock as final and does not post it again', async () => {
        // The borrower cannot fund the lock: the ledger definitely refuses it.
        const product = await makeProduct();
        await fundReserve('USDT', '100000');
        await expect(
          loans.open({ loanId: LOAN_ID, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now }),
        ).rejects.toMatchObject({ code: 'bank.loan_collateral_short' });
        const lock = await sql<Array<{ status: string }>>`
          SELECT status FROM bank.loan_collateral_events WHERE loan_id = ${LOAN_ID} AND sequence = 0
        `;
        expect(lock[0]!.status).toBe('rejected');

        // The borrower now has the funds. Recovery must still NOT lock and draw on its own.
        await fund(BORROWER, 'BTC', '1');
        const resumed = await loans.resumePending(100, now);

        expect(resumed).toHaveLength(1);
        expect(resumed[0]).toMatchObject({ loanId: LOAN_ID, outcome: 'failed' });
        expect(resumed[0]!.reason).toMatch(/collateral_rejected/);
        expect((await loans.loan(LOAN_ID)).status).toBe('pending');
        expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.loan.collateral.lock:'))).toHaveLength(0);
        expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.loan.draw:'))).toHaveLength(0);
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('1');
      });
    });

    it('a retried open with the same loanId opens ONE loan, not two', async () => {
      await fundReserve('USDT', '100000');
      await fund(BORROWER, 'BTC', '2');
      const product = await makeProduct();

      const loanId = '44444444-4444-4444-8444-444444444444';
      const args = { loanId, productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now };

      const first = await loans.open(args);
      const second = await loans.open(args);

      expect(second.loan.id).toBe(first.loan.id);
      const rows = await sql`SELECT id FROM bank.loans`;
      expect(rows).toHaveLength(1);
      // And the borrower was charged one lot of collateral, not two.
      expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('1');
    });

    // ── Accrual ──────────────────────────────────────────────────────────────

    describe('interest accrual is idempotent per (loan, day)', () => {
      async function openLoan() {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct({ aprBps: 3_650 }); // 36.5% APR == 0.1%/day
        return loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now });
      }

      it('charges nothing on the day the loan opens', async () => {
        const { loan } = await openLoan();
        const result = await loans.accrue({ loanId: loan.id, until: new Date(now.getTime() + 6 * 3_600_000) });
        expect(result.days).toHaveLength(0);
        expect(formatAmount((await loans.outstanding(loan.id)).total)).toBe('5000');
      });

      /**
       * THE GUARD. A crashed run that re-runs must charge each day ONCE. Daily
       * compounding that double-applies is not a reporting error — it is a charge
       * the borrower never incurred, and from that day forward it compounds.
       */
      it('running the job three times for the same day charges that day once', async () => {
        const { loan } = await openLoan();
        const until = new Date(now.getTime() + DAY_MS);

        const first = await loans.accrue({ loanId: loan.id, until });
        const second = await loans.accrue({ loanId: loan.id, until });
        const third = await loans.accrue({ loanId: loan.id, until });

        expect(first.days).toHaveLength(1);
        expect(first.days[0]!.alreadyAccrued).toBe(false);
        // Subsequent runs find nothing left to charge.
        expect(second.days).toHaveLength(0);
        expect(third.days).toHaveLength(0);

        const rows = await sql`SELECT accrual_date FROM bank.loan_interest_accruals WHERE loan_id = ${loan.id}`;
        expect(rows).toHaveLength(1);

        // 5000 at 0.1%/day = 5.
        expect(formatAmount((await loans.outstanding(loan.id)).interest)).toBe('5');
      });

      it('catches up a three-day outage, charging each day once and compounding correctly', async () => {
        const { loan } = await openLoan();
        const until = new Date(now.getTime() + 3 * DAY_MS);

        const result = await loans.accrue({ loanId: loan.id, until });
        expect(result.days.map((d) => d.date)).toEqual(['2026-06-02', '2026-06-03', '2026-06-04']);

        // Compounded day by day, each on the PREVIOUS day's closing debt:
        //   5000 → +5 → 5005 → +5.005 → 5010.005 → +5.010005 → 5015.015005.
        // Simple interest would have charged 5 three times and landed on 5015.
        expect(formatAmount((await loans.outstanding(loan.id)).total)).toBe('5015.015005');

        // Each day's own basis is snapshotted, so any past day is re-derivable.
        const rows = await sql<Array<{ principal_basis: string }>>`
          SELECT principal_basis FROM bank.loan_interest_accruals WHERE loan_id = ${loan.id} ORDER BY accrual_date
        `;
        expect(rows.map((r) => formatAmount(amt(r.principal_basis)))).toEqual(['5000', '5005', '5010.005']);
      });

      /**
       * THE BORROWER MUST NOT PAY FOR THE OUTAGE.
       *
       * Two identical loans. One is accrued nightly; the other has its job down
       * for three days and then catches up in a single run. The debts must agree
       * exactly — a borrower cannot be charged more (or less) because the
       * platform was unavailable.
       */
      it('a catch-up charges exactly what three separate nightly runs would have', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        await fund(OTHER, 'BTC', '1');
        const product = await makeProduct({ aprBps: 3_650 });

        const nightlyLoan = (
          await loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
        ).loan;
        const caughtUpLoan = (
          await loans.open({ productId: product.id, userId: OTHER, collateralAmount: amt('1'), principal: amt('5000'), now })
        ).loan;

        for (let day = 1; day <= 3; day++) {
          await loans.accrue({ loanId: nightlyLoan.id, until: new Date(now.getTime() + day * DAY_MS) });
        }
        await loans.accrue({ loanId: caughtUpLoan.id, until: new Date(now.getTime() + 3 * DAY_MS) });

        const nightly = await loans.outstanding(nightlyLoan.id);
        const caughtUp = await loans.outstanding(caughtUpLoan.id);

        expect(formatAmount(caughtUp.total)).toBe(formatAmount(nightly.total));
        expect(formatAmount(caughtUp.total)).toBe('5015.015005');

        // And each charged three days, not one and not six.
        const perLoan = await sql<Array<{ loan_id: string; n: string }>>`
          SELECT loan_id, COUNT(*)::text AS n FROM bank.loan_interest_accruals GROUP BY loan_id
        `;
        expect(perLoan.map((r) => r.n)).toEqual(['3', '3']);
      });

      /** Accrual moves no value, so there is no ledger transaction to deduplicate. */
      it('posts nothing to the ledger — interest capitalises rather than being debited', async () => {
        const { loan } = await openLoan();
        const before = (await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount;
        const houseBefore = (await ledger.balance(houseFees('bank', 'USDT'))).amount;

        await loans.accrue({ loanId: loan.id, until: new Date(now.getTime() + DAY_MS) });

        expect((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount).toBe(before);
        expect((await ledger.balance(houseFees('bank', 'USDT'))).amount).toBe(houseBefore);
        // But the debt grew.
        expect(formatAmount((await loans.outstanding(loan.id)).interest)).toBe('5');
      });

      it('does not charge interest on a loan whose principal was never drawn', async () => {
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        await loans
          .open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
          .catch(() => undefined);

        const rows = await sql<Array<{ id: string }>>`SELECT id FROM bank.loans`;
        const result = await loans.accrue({ loanId: rows[0]!.id, until: new Date(now.getTime() + 5 * DAY_MS) });
        expect(result.days).toHaveLength(0);
      });
    });

    // ── Repayment and release ────────────────────────────────────────────────

    describe('repayment', () => {
      async function openLoan() {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct({ aprBps: 3_650 });
        return loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now });
      }

      it('settles interest before principal', async () => {
        const { loan } = await openLoan();
        await loans.accrue({ loanId: loan.id, until: new Date(now.getTime() + DAY_MS) });

        const result = await loans.repay({ eventId: randomUUID(), loanId: loan.id, amount: amt('100') });
        expect(formatAmount(result.interestPaid)).toBe('5');
        expect(formatAmount(result.principalPaid)).toBe('95');
        expect(formatAmount(result.remaining.total)).toBe('4905');
      });

      /**
       * THE MOST IMPORTANT PRECONDITION IN THE MODULE.
       *
       * Releasing collateral on a live loan converts a secured position into an
       * unsecured one in one transaction, and there is no posting that undoes it
       * once the borrower has withdrawn.
       */
      it('refuses to release collateral while anything is outstanding', async () => {
        const { loan } = await openLoan();
        await loans.repay({ eventId: randomUUID(), loanId: loan.id, amount: amt('1000') });

        await expect(loans.releaseSettled(loan.id)).rejects.toThrow(/still owes/);
        expect(formatAmount(await loans.collateralOf(loan))).toBe('1');
      });

      it('releases the collateral automatically the moment the debt reaches zero', async () => {
        const { loan } = await openLoan();
        const result = await loans.repay({ eventId: randomUUID(), loanId: loan.id, amount: amt('5000') });

        expect(result.closed).toBe(true);
        expect(formatAmount(await loans.collateralOf(loan))).toBe('0');
        expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('1');
        expect((await loans.loan(loan.id)).status).toBe('repaid');
      });

      it('never takes more than is owed', async () => {
        const { loan } = await openLoan();
        await fund(BORROWER, 'USDT', '10000');

        const result = await loans.repay({ eventId: randomUUID(), loanId: loan.id, amount: amt('99999') });
        expect(formatAmount(result.principalPaid)).toBe('5000');
        expect(formatAmount(result.remaining.total)).toBe('0');
      });

      it('a repayment the borrower cannot fund fails without corrupting the loan', async () => {
        const { loan } = await openLoan();
        await ledger.post(
          recipes.withdrawHold({ userId: BORROWER, assetId: 'USDT', amount: amt('5000'), rail: 'test', withdrawalId: 'drain' }),
        );

        await expect(loans.repay({ eventId: randomUUID(), loanId: loan.id, amount: amt('1000') })).rejects.toThrow(/[Ii]nsufficient/);

        // The claim row records the refusal; the debt is untouched.
        const rows = await sql<Array<{ status: string }>>`SELECT status FROM bank.loan_repayments WHERE loan_id = ${loan.id}`;
        expect(rows[0]!.status).toBe('rejected');
        expect(formatAmount((await loans.outstanding(loan.id)).total)).toBe('5000');
      });
    });

    // ── The sweep: marking, calling, laddering ───────────────────────────────

    describe('the risk sweep', () => {
      async function openAt(collateralPrice: string, principal = '5000') {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        // Seed the market maker so a liquidation has a funded counterparty.
        await fund(MM_SWEEP, 'USDT', '100000');
        await ledger.post({
          idempotencyKey: `seed-mm-${Math.random()}`,
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(MM_SWEEP, 'USDT'), direction: 'credit', amount: amt('100000') },
            { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
          ],
        });

        const product = await makeProduct();
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt(principal),
          now,
        });
        loans = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: price(collateralPrice),
          marginCalls: {
            send: async (i) => {
              calls.push({ loanId: i.loanId, ltvBps: i.ltvBps });
            },
          },
          venue: marketMakerVenue(),
        });
        return opened;
      }

      it('leaves a healthy loan alone', async () => {
        const opened = await openAt('10000');
        const sweep = await sweepAt(now);
        expect(sweep.called).toBe(0);
        expect(sweep.liquidated).toBe(0);
        expect((await loans.loan(opened.loan.id)).status).toBe('active');
      });

      it('raises a margin call, records it, and delivers it', async () => {
        const opened = await openAt('6500'); // 5000/6500 = 76.93%
        const sweep = await sweepAt(now);

        expect(sweep.called).toBe(1);
        expect(calls).toHaveLength(1);

        const rows = await sql<Array<{ ltv_bps: number; notified_at: Date | null; cure_collateral_amount: string }>>`
          SELECT ltv_bps, notified_at, cure_collateral_amount FROM bank.loan_margin_calls WHERE loan_id = ${opened.loan.id}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.notified_at).not.toBeNull();
        // The cure figure is what actually clears the call, rounded UP so posting
        // exactly that much does not land a unit short.
        expect(amt(rows[0]!.cure_collateral_amount)).toBeGreaterThan(0n);

        expect((await loans.loan(opened.loan.id)).status).toBe('margin_call');
      });

      /**
       * THE ORDERING, END TO END. A loan that crosses the liquidation threshold
       * on its FIRST mark is called, not liquidated — however bad the number.
       */
      it('does not liquidate on the first mark that crosses the threshold', async () => {
        const opened = await openAt('5700'); // ~87.7% — above liquidation, below insolvency
        const sweep = await sweepAt(now);

        expect(sweep.liquidated).toBe(0);
        expect(sweep.called).toBe(1);
        const rows = await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`;
        expect(rows).toHaveLength(0);
      });

      it('does not liquidate while grace is still running', async () => {
        const opened = await openAt('5700');
        await sweepAt(now);
        // Ten minutes later; grace is an hour.
        const sweep = await sweepAt(new Date(now.getTime() + 10 * 60_000));
        expect(sweep.liquidated).toBe(0);
        expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`).toHaveLength(0);
      });

      it('liquidates a partial tranche once the call has been served and grace has expired', async () => {
        const opened = await openAt('5700');
        await sweepAt(now);

        const later = new Date(now.getTime() + 2 * 3_600_000);
        const sweep = await sweepAt(later);

        expect(sweep.liquidated).toBe(1);

        const rows = await sql<Array<{ tranche: number; collateral_sold: string; grace_waived: boolean; status: string }>>`
          SELECT tranche, collateral_sold, grace_waived, status FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.tranche).toBe(0);
        expect(rows[0]!.status).toBe('settled');
        expect(rows[0]!.grace_waived).toBe(false);

        // PARTIAL. Not the whole position.
        const sold = amt(rows[0]!.collateral_sold);
        expect(sold).toBeGreaterThan(0n);
        expect(sold).toBeLessThan(amt('1'));
        expect(formatAmount(await loans.collateralOf(await loans.loan(opened.loan.id)))).not.toBe('0');
      });

      it('waives grace past the insolvency threshold, and records that it did', async () => {
        const opened = await openAt('5200'); // ~96.2%
        const sweep = await sweepAt(now);

        expect(sweep.liquidated).toBe(1);
        const rows = await sql<Array<{ grace_waived: boolean }>>`
          SELECT grace_waived FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}
        `;
        expect(rows[0]!.grace_waived).toBe(true);
      });

      it('clears a margin call when the borrower posts collateral', async () => {
        const opened = await openAt('6500');
        await sweepAt(now);
        expect((await loans.loan(opened.loan.id)).status).toBe('margin_call');

        await fund(BORROWER, 'BTC', '1');
        await loans.addCollateral({ loanId: opened.loan.id, eventId: randomUUID(), amount: amt('1'), now });

        const sweep = await sweepAt(new Date(now.getTime() + 60_000));
        expect(sweep.cleared).toBe(1);

        const loan = await loans.loan(opened.loan.id);
        expect(loan.status).toBe('active');
        // THE GRACE CLOCK IS RESET. A borrower who cured is entitled to a fresh
        // warning and a fresh hour before anything of theirs is sold.
        expect(loan.marginCalledAt).toBeNull();

        const open = await sql`SELECT id FROM bank.loan_margin_calls WHERE loan_id = ${opened.loan.id} AND cleared_at IS NULL`;
        expect(open).toHaveLength(0);
      });

      /**
       * A borrower's first notice of a liquidation must never be the receipt. This
       * checks the whole chain in order: call raised → recorded → grace → tranche.
       */
      it('a liquidation is always preceded by a recorded margin call', async () => {
        const opened = await openAt('5700');
        await sweepAt(now);
        await sweepAt(new Date(now.getTime() + 2 * 3_600_000));

        const call = await sql<Array<{ called_at: Date }>>`
          SELECT called_at FROM bank.loan_margin_calls WHERE loan_id = ${opened.loan.id} ORDER BY sequence LIMIT 1
        `;
        const liq = await sql<Array<{ created_at: Date }>>`
          SELECT created_at FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id} ORDER BY tranche LIMIT 1
        `;

        expect(call).toHaveLength(1);
        expect(liq).toHaveLength(1);
        expect(call[0]!.called_at.getTime()).toBeLessThan(liq[0]!.created_at.getTime());
      });

      /**
       * A doubtful mark costs a borrower a notification; a doubtful liquidation
       * costs them their collateral. So a loan whose mark fails the liquidation
       * guards is REFUSED and left for an operator, not sold.
       */
      it('refuses to liquidate on a mark quality that must not seize collateral', async () => {
        const opened = await openAt('5700');
        await sweepAt(now);

        // Same price, but now sourced from a single trade print.
        loans = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: fixedPriceSource({ BTC: { price: '5700', quality: 'last' } }, () => markNow),
          venue: marketMakerVenue(),
        });

        const sweep = await sweepAt(new Date(now.getTime() + 2 * 3_600_000));
        expect(sweep.liquidated).toBe(0);
        expect(sweep.refused).toHaveLength(1);
        expect(sweep.refused[0]!.reason).toMatch(/single print must not seize collateral/);
        expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`).toHaveLength(0);
      });

      it('will not liquidate when no counterparty can take the collateral', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        const product = await makeProduct();
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        });

        const noBuyer: LiquidationVenue = { quote: async () => null };
        loans = new LoanService(sql, ledger, { originationFeeBps: '0', priceSource: price('5700'), venue: noBuyer });

        await sweepAt(now);
        const sweep = await sweepAt(new Date(now.getTime() + 2 * 3_600_000));

        expect(sweep.liquidated).toBe(0);
        expect(sweep.refused[0]!.reason).toMatch(/No counterparty/);
      });

      /**
       * HONESTY RESIDUAL: full collateral sale with unpaid interest remaining
       * must NOT false-cure to healthy `active`.
       *
       * After the last unit of collateral is sold, `planLiquidation` returns
       * `action: none` (nothing left to sell). The old markAndAct path treated
       * `none` + `marginCalledAt` as "cured" and wrote status=active with zero
       * collateral and residual interest still outstanding — an unsecured
       * claim reported as a healthy loan.
       *
       * Choice (b): status stays non-active until residual interest is repaid
       * (or a future named write-off). Interest is not pushed through
       * `loanBadDebt` (that recipe restores the reserve; interest never sat there).
       */
      it('does not false-cure to active after full coll sale leaves unpaid interest', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        await fund(MM_SWEEP, 'USDT', '100000');
        await ledger.post({
          idempotencyKey: `seed-mm-fc-${Math.random()}`,
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(MM_SWEEP, 'USDT'), direction: 'credit', amount: amt('100000') },
            { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
          ],
        });
        // Insurance covers principal shortfall after the dust sale.
        await fund(INSURANCE_FUNDER, 'USDT', '10000');
        await ledger.post({
          idempotencyKey: `seed-ins-fc-${Math.random()}`,
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(INSURANCE_FUNDER, 'USDT'), direction: 'credit', amount: amt('10000') },
            { account: insuranceFund('USDT'), direction: 'debit', amount: amt('10000') },
          ],
        });

        // Full-tranche policy so one insolvency rung exhausts collateral.
        const product = await makeProduct({
          aprBps: 3_650,
          policy: { ...DEFAULT_LIQUIDATION_POLICY, maxTrancheBps: 10_000 },
        });
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        });
        // ~5 USDT interest after one day at 36.5% APR on 5000.
        await loans.accrue({ loanId: opened.loan.id, until: new Date(now.getTime() + DAY_MS) });
        const interestBefore = (await loans.outstanding(opened.loan.id)).interest;
        expect(interestBefore).toBeGreaterThan(0n);

        // Gap crash: 1 USDT/BTC → proceeds 1 < interest; insolvency waives grace.
        loans = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: price('1'),
          venue: marketMakerVenue(),
          marginCalls: { send: async () => undefined },
        });
        const crash = await sweepAt(now);
        expect(crash.liquidated).toBe(1);

        const afterSale = await loans.loan(opened.loan.id);
        expect(formatAmount(await loans.collateralOf(afterSale))).toBe('0');
        const residual = await loans.outstanding(opened.loan.id);
        expect(residual.interest).toBeGreaterThan(0n);
        expect(residual.total).toBeGreaterThan(0n);
        // Closing rung left residual debt → must not already look healthy.
        expect(afterSale.status).not.toBe('active');

        // Next mark: nothing left to sell → planLiquidation action:none.
        // Must NOT clear to active-healthy with unsecured residual interest.
        const next = await sweepAt(new Date(now.getTime() + 60_000));
        expect(next.cleared).toBe(0);

        const afterMark = await loans.loan(opened.loan.id);
        expect(afterMark.status).not.toBe('active');
        expect(afterMark.status).toBe('margin_call');
        expect((await loans.outstanding(opened.loan.id)).interest).toBeGreaterThan(0n);
      });

      /** One bad mark must not stop the sweep for everybody else. */
      it('keeps sweeping past a loan it cannot mark', async () => {
        await openAt('10000');
        await fund(OTHER, 'ETH', '10');
        const exotic = await makeProduct({ name: 'ETH-backed', collateralAssetId: 'ETH' });
        await fundReserve('USDT', '100000');
        await loans
          .open({ productId: exotic.id, userId: OTHER, collateralAmount: amt('10'), principal: amt('1'), now })
          .catch(() => undefined);

        const sweep = await sweepAt(now);
        // The BTC loan was marked; the ETH one has no mark and is reported.
        expect(sweep.marked + sweep.refused.length).toBeGreaterThanOrEqual(1);
      });

      /**
       * Crash after the sale and the bad-debt post, before status becomes
       * settled. The row already holds the first quote. A later quote must not
       * replace that shortfall, the proceeds, or the split, and must not post
       * a second ledger transaction. The pending rung is finished as stored.
       */
      it('keeps the stored shortfall when a pending liquidation with a ledger tx is retried on a later quote', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        await fund(MM_SWEEP, 'USDT', '100000');
        await ledger.post({
          idempotencyKey: 'seed-mm-retry-shortfall',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(MM_SWEEP, 'USDT'), direction: 'credit', amount: amt('100000') },
            { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
          ],
        });
        await fund(INSURANCE_FUNDER, 'USDT', '10000');
        await ledger.post({
          idempotencyKey: 'seed-ins-retry-shortfall',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(INSURANCE_FUNDER, 'USDT'), direction: 'credit', amount: amt('10000') },
            { account: insuranceFund('USDT'), direction: 'debit', amount: amt('10000') },
          ],
        });

        const product = await makeProduct({
          policy: { ...DEFAULT_LIQUIDATION_POLICY, maxTrancheBps: 10_000 },
        });
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        });

        const sold = await ledger.post(
          recipes.loanLiquidate({
            loanId: opened.loan.id,
            userId: BORROWER,
            tranche: 0,
            collateralAssetId: 'BTC',
            collateralSold: amt('0.25'),
            debtAssetId: 'USDT',
            proceeds: amt('1000'),
            principalRepaid: amt('1000'),
            interestRepaid: 0n,
            penalty: 0n,
            surplusToBorrower: 0n,
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
            markPrice: amt('10000'),
          }),
        );
        const bad = await ledger.post(recipes.loanBadDebt({ loanId: opened.loan.id, debtAssetId: 'USDT', shortfall: amt('4000') }));

        await sql`
          INSERT INTO bank.loan_liquidations (
            loan_id, tranche, ltv_bps, mark_price, grace_waived, collateral_sold, proceeds,
            principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
            ledger_tx_id, bad_debt_ledger_tx_id, status
          ) VALUES (
            ${opened.loan.id}, 0, 9000, '10000'::numeric, true, '0.25'::numeric, '1000'::numeric,
            '1000'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '4000'::numeric,
            ${sold.id}, ${bad.id}, 'pending'
          )
        `;

        const insuranceBefore = (await ledger.balance(insuranceFund('USDT'))).amount;
        const laterQuote: LiquidationVenue = {
          quote: async () => ({
            proceeds: amt('100'),
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
          }),
        };
        loans = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: price('1'),
          venue: laterQuote,
          marginCalls: { send: async () => undefined },
        });

        const sweep = await sweepAt(now);
        expect(sweep.refused).toEqual([]);
        expect(sweep.liquidated).toBe(1);

        const rows = await sql<
          Array<{
            status: string;
            shortfall: string;
            proceeds: string;
            principal_repaid: string;
            interest_repaid: string;
            penalty: string;
            surplus_returned: string;
            ledger_tx_id: string | null;
            bad_debt_ledger_tx_id: string | null;
          }>
        >`
          SELECT status, shortfall::text AS shortfall, proceeds::text AS proceeds,
                 principal_repaid::text AS principal_repaid, interest_repaid::text AS interest_repaid,
                 penalty::text AS penalty, surplus_returned::text AS surplus_returned,
                 ledger_tx_id, bad_debt_ledger_tx_id
            FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}
        `;
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.status).toBe('settled');
        expect(formatAmount(amt(row.shortfall))).toBe('4000');
        expect(formatAmount(amt(row.proceeds))).toBe('1000');
        expect(formatAmount(amt(row.principal_repaid))).toBe('1000');
        expect(formatAmount(amt(row.interest_repaid))).toBe('0');
        expect(formatAmount(amt(row.penalty))).toBe('0');
        expect(formatAmount(amt(row.surplus_returned))).toBe('0');
        expect(row.ledger_tx_id).toBe(sold.id);
        expect(row.bad_debt_ledger_tx_id).toBe(bad.id);
        expect((await ledger.getTxByKey(`bank.loan.liquidate:${opened.loan.id}:0`))!.id).toBe(sold.id);
        expect((await ledger.getTxByKey(`bank.loan.baddebt:${opened.loan.id}`))!.id).toBe(bad.id);
        expect((await ledger.balance(insuranceFund('USDT'))).amount).toBe(insuranceBefore);
      });

      /**
       * Crash after drivenPost stores ledger_tx_id and before it writes
       * shortfall. The claim still has shortfall 0. The stored sale already
       * took the whole collateral and repaid 1000 of 5000 principal, so the
       * closing rule is a shortfall of 4000. A later quote must not replace
       * that sale or post a second liquidation. The retry posts the shortfall
       * once, with the bad-debt tx, before the row is settled.
       */
      it('finishes a pending liquidation from the stored sale when shortfall is still 0', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        await fund(MM_SWEEP, 'USDT', '100000');
        await ledger.post({
          idempotencyKey: 'seed-mm-retry-stored-sale',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(MM_SWEEP, 'USDT'), direction: 'credit', amount: amt('100000') },
            { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
          ],
        });
        await fund(INSURANCE_FUNDER, 'USDT', '10000');
        await ledger.post({
          idempotencyKey: 'seed-ins-retry-stored-sale',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(INSURANCE_FUNDER, 'USDT'), direction: 'credit', amount: amt('10000') },
            { account: insuranceFund('USDT'), direction: 'debit', amount: amt('10000') },
          ],
        });

        const product = await makeProduct({
          policy: { ...DEFAULT_LIQUIDATION_POLICY, maxTrancheBps: 10_000 },
        });
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        });

        const sold = await ledger.post(
          recipes.loanLiquidate({
            loanId: opened.loan.id,
            userId: BORROWER,
            tranche: 0,
            collateralAssetId: 'BTC',
            collateralSold: amt('1'),
            debtAssetId: 'USDT',
            proceeds: amt('1000'),
            principalRepaid: amt('1000'),
            interestRepaid: 0n,
            penalty: 0n,
            surplusToBorrower: 0n,
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
            markPrice: amt('10000'),
          }),
        );

        await sql`
          INSERT INTO bank.loan_liquidations (
            loan_id, tranche, ltv_bps, mark_price, grace_waived, collateral_sold, proceeds,
            principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
            ledger_tx_id, status
          ) VALUES (
            ${opened.loan.id}, 0, 9000, '10000'::numeric, true, '1'::numeric, '1000'::numeric,
            '1000'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '0'::numeric,
            ${sold.id}, 'pending'
          )
        `;

        const insuranceBefore = (await ledger.balance(insuranceFund('USDT'))).amount;
        const laterQuote: LiquidationVenue = {
          quote: async () => ({
            proceeds: amt('100'),
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
          }),
        };
        loans = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: price('1'),
          venue: laterQuote,
          marginCalls: { send: async () => undefined },
        });

        const sweep = await sweepAt(now);
        expect(sweep.refused).toEqual([]);
        expect(sweep.liquidated).toBe(1);

        const rows = await sql<
          Array<{
            status: string;
            shortfall: string;
            proceeds: string;
            principal_repaid: string;
            interest_repaid: string;
            penalty: string;
            surplus_returned: string;
            collateral_sold: string;
            ledger_tx_id: string | null;
            bad_debt_ledger_tx_id: string | null;
          }>
        >`
          SELECT status, shortfall::text AS shortfall, proceeds::text AS proceeds,
                 principal_repaid::text AS principal_repaid, interest_repaid::text AS interest_repaid,
                 penalty::text AS penalty, surplus_returned::text AS surplus_returned,
                 collateral_sold::text AS collateral_sold,
                 ledger_tx_id, bad_debt_ledger_tx_id
            FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}
        `;
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.status).toBe('settled');
        // Closing sale: principal still owed is 5000 - 1000 repaid.
        expect(formatAmount(amt(row.shortfall))).toBe('4000');
        expect(formatAmount(amt(row.proceeds))).toBe('1000');
        expect(formatAmount(amt(row.principal_repaid))).toBe('1000');
        expect(formatAmount(amt(row.interest_repaid))).toBe('0');
        expect(formatAmount(amt(row.penalty))).toBe('0');
        expect(formatAmount(amt(row.surplus_returned))).toBe('0');
        expect(formatAmount(amt(row.collateral_sold))).toBe('1');
        expect(row.ledger_tx_id).toBe(sold.id);
        const badDebt = await ledger.getTxByKey(`bank.loan.baddebt:${opened.loan.id}`);
        expect(badDebt).not.toBeNull();
        expect(row.bad_debt_ledger_tx_id).toBe(badDebt!.id);
        expect((await ledger.getTxByKey(`bank.loan.liquidate:${opened.loan.id}:0`))!.id).toBe(sold.id);
        expect((await ledger.balance(insuranceFund('USDT'))).amount).toBe(insuranceBefore - amt('4000'));
        expect(formatAmount((await loans.outstanding(opened.loan.id)).principal)).toBe('0');

        const again = await sweepAt(new Date(now.getTime() + 60_000));
        expect(again.liquidated).toBe(0);
        expect((await ledger.getTxByKey(`bank.loan.baddebt:${opened.loan.id}`))!.id).toBe(badDebt!.id);
        expect((await ledger.balance(insuranceFund('USDT'))).amount).toBe(insuranceBefore - amt('4000'));
      });

      /**
       * The same crash window, on a sale that left collateral behind. The
       * closing rule books no shortfall. Settle at 0 and do not post bad debt.
       * A later quote must not replace the stored sale.
       */
      it('settles a non-closing stored sale at shortfall 0 without posting bad debt', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        await fund(MM_SWEEP, 'USDT', '100000');
        await ledger.post({
          idempotencyKey: 'seed-mm-retry-open-sale',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(MM_SWEEP, 'USDT'), direction: 'credit', amount: amt('100000') },
            { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
          ],
        });
        await fund(INSURANCE_FUNDER, 'USDT', '10000');
        await ledger.post({
          idempotencyKey: 'seed-ins-retry-open-sale',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(INSURANCE_FUNDER, 'USDT'), direction: 'credit', amount: amt('10000') },
            { account: insuranceFund('USDT'), direction: 'debit', amount: amt('10000') },
          ],
        });

        const product = await makeProduct({
          policy: { ...DEFAULT_LIQUIDATION_POLICY, maxTrancheBps: 10_000 },
        });
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        });

        const sold = await ledger.post(
          recipes.loanLiquidate({
            loanId: opened.loan.id,
            userId: BORROWER,
            tranche: 0,
            collateralAssetId: 'BTC',
            collateralSold: amt('0.25'),
            debtAssetId: 'USDT',
            proceeds: amt('1000'),
            principalRepaid: amt('1000'),
            interestRepaid: 0n,
            penalty: 0n,
            surplusToBorrower: 0n,
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
            markPrice: amt('10000'),
          }),
        );

        await sql`
          INSERT INTO bank.loan_liquidations (
            loan_id, tranche, ltv_bps, mark_price, grace_waived, collateral_sold, proceeds,
            principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
            ledger_tx_id, status
          ) VALUES (
            ${opened.loan.id}, 0, 9000, '10000'::numeric, true, '0.25'::numeric, '1000'::numeric,
            '1000'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '0'::numeric,
            ${sold.id}, 'pending'
          )
        `;

        const insuranceBefore = (await ledger.balance(insuranceFund('USDT'))).amount;
        const laterQuote: LiquidationVenue = {
          quote: async () => ({
            proceeds: amt('100'),
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
          }),
        };
        loans = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: price('1'),
          venue: laterQuote,
          marginCalls: { send: async () => undefined },
        });

        const sweep = await sweepAt(now);
        expect(sweep.refused).toEqual([]);
        expect(sweep.liquidated).toBe(1);

        const rows = await sql<
          Array<{
            status: string;
            shortfall: string;
            proceeds: string;
            principal_repaid: string;
            interest_repaid: string;
            penalty: string;
            surplus_returned: string;
            collateral_sold: string;
            ledger_tx_id: string | null;
            bad_debt_ledger_tx_id: string | null;
          }>
        >`
          SELECT status, shortfall::text AS shortfall, proceeds::text AS proceeds,
                 principal_repaid::text AS principal_repaid, interest_repaid::text AS interest_repaid,
                 penalty::text AS penalty, surplus_returned::text AS surplus_returned,
                 collateral_sold::text AS collateral_sold,
                 ledger_tx_id, bad_debt_ledger_tx_id
            FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}
        `;
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.status).toBe('settled');
        expect(formatAmount(amt(row.shortfall))).toBe('0');
        expect(formatAmount(amt(row.proceeds))).toBe('1000');
        expect(formatAmount(amt(row.principal_repaid))).toBe('1000');
        expect(formatAmount(amt(row.interest_repaid))).toBe('0');
        expect(formatAmount(amt(row.penalty))).toBe('0');
        expect(formatAmount(amt(row.surplus_returned))).toBe('0');
        expect(formatAmount(amt(row.collateral_sold))).toBe('0.25');
        expect(row.ledger_tx_id).toBe(sold.id);
        expect(row.bad_debt_ledger_tx_id).toBeNull();
        expect((await ledger.getTxByKey(`bank.loan.liquidate:${opened.loan.id}:0`))!.id).toBe(sold.id);
        expect(await ledger.getTxByKey(`bank.loan.baddebt:${opened.loan.id}`)).toBeNull();
        expect((await ledger.balance(insuranceFund('USDT'))).amount).toBe(insuranceBefore);
      });

      function sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function saleCount(): number {
        return ledger.journal().filter((tx) => tx.reason === 'loan.liquidated').length;
      }

      it('does not sell a stale collateral plan after an addCollateral top-up with unchanged debt', async () => {
        const opened = await openAt('5200');
        await fund(BORROWER, 'BTC', '1');
        const debtBefore = await loans.outstanding(opened.loan.id);
        const originalCollateralOf = loans.collateralOf.bind(loans);
        const collateralReads: string[] = [];
        let toppedUp = false;

        loans.collateralOf = async (loan) => {
          const held = await originalCollateralOf(loan);
          collateralReads.push(formatAmount(held));
          if (!toppedUp) {
            toppedUp = true;
            // Complete a real top-up after the sweep reads its collateral,
            // before it can acquire the liquidation lock. Debt stays the same.
            await loans.addCollateral({ loanId: loan.id, eventId: randomUUID(), amount: amt('1'), now });
          }
          return held;
        };

        try {
          const sweep = await sweepAt(now);
          expect(sweep.refused).toEqual([]);
        } finally {
          loans.collateralOf = originalCollateralOf;
        }

        expect(toppedUp).toBe(true);
        expect(collateralReads.slice(0, 2)).toEqual(['1', '2']);
        expect(saleCount()).toBe(0);
        expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`).toHaveLength(0);
        expect(await loans.outstanding(opened.loan.id)).toEqual(debtBefore);
        expect(await loans.collateralOf(opened.loan)).toBe(amt('2'));
        expect(ledger.reconcile()).toEqual({ ok: true });
      });

      /**
       * Two sweeps read debt before the first sale; the second reads collateral
       * after that sale. Even though its remaining collateral still matches at
       * claim time, its debt is stale and must not authorize another tranche.
       * The first sale is held until the second waits on the real session lock.
       * One open loan, one sale.
       */
      it('two overlapping sweeps of one open loan do not each sell the same collateral', async () => {
        const opened = await openAt('5200');
        const innerPost = ledger.post.bind(ledger);
        let parked = false;
        let releasePark!: () => void;
        const park = new Promise<void>((resolve) => {
          releasePark = () => resolve();
        });
        let firstSaleLanded!: () => void;
        const firstSale = new Promise<void>((resolve) => {
          firstSaleLanded = () => resolve();
        });
        ledger.post = async (request: PostRequest) => {
          const posted = await innerPost(request);
          if (!parked && request.reason === 'loan.liquidated') {
            parked = true;
            firstSaleLanded();
            await park;
          }
          return posted;
        };

        // Both sweeps read the old debt. Let the second read its collateral
        // only after the first sale posts: its plan then mixes old debt with
        // the remaining collateral, which the collateral-only guard accepts.
        const originalOutstanding = loans.outstanding.bind(loans);
        let debtReads = 0;
        let bothDebtsRead!: () => void;
        const debtsRead = new Promise<void>((resolve) => {
          bothDebtsRead = resolve;
        });
        loans.outstanding = async (loanId) => {
          const debt = await originalOutstanding(loanId);
          const place = ++debtReads;
          if (place <= 2) {
            if (place === 2) bothDebtsRead();
            await debtsRead;
            if (place === 2) await firstSale;
          }
          return debt;
        };

        let trancheReads = 0;
        let sawLockWait = false;
        let watch = true;
        const originalUnsafe = sql.unsafe.bind(sql);
        sql.unsafe = ((query: string, parameters?: Parameters<Sql['unsafe']>[1], queryOptions?: Parameters<Sql['unsafe']>[2]) => {
          if (query.includes('MAX(') && query.includes('tranche') && query.includes('loan_liquidations')) {
            trancheReads += 1;
            if (trancheReads >= 2) {
              return firstSale.then(() => originalUnsafe(query, parameters, queryOptions)) as ReturnType<Sql['unsafe']>;
            }
          }
          return originalUnsafe(query, parameters, queryOptions);
        }) as typeof sql.unsafe;

        const watcher = (async () => {
          while (watch) {
            if (parked) {
              const waits = await originalUnsafe<{ n: number }[]>(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND wait_event_type = 'Lock'
                    AND pid <> pg_backend_pid()`,
              );
              if (Number(waits[0]?.n ?? 0) > 0) sawLockWait = true;
              if (Number(waits[0]?.n ?? 0) > 0 || saleCount() >= 2) releasePark();
            }
            await sleep(20);
          }
        })();

        try {
          await Promise.race([
            Promise.all([sweepAt(now), sweepAt(now)]),
            sleep(15_000).then(() => {
              throw new Error('overlapping liquidations did not finish');
            }),
          ]);
        } finally {
          watch = false;
          releasePark();
          firstSaleLanded();
          ledger.post = innerPost;
          sql.unsafe = originalUnsafe;
          loans.outstanding = originalOutstanding;
          bothDebtsRead();
          await watcher;
        }

        expect(trancheReads >= 2 || sawLockWait).toBe(true);
        expect(saleCount()).toBe(1);
        const rows = await sql<Array<{ tranche: number; status: string }>>`
          SELECT tranche, status FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id} ORDER BY tranche
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.tranche).toBe(0);
        expect(rows[0]!.status).toBe('settled');
        const after = await loans.loan(opened.loan.id);
        expect(after.status === 'margin_call' || after.status === 'liquidated').toBe(true);
        expect(await loans.collateralOf(after)).toBe(amt('0.75'));
        expect((await loans.outstanding(after.id)).principal).toBe(amt('3700'));
        expect(ledger.reconcile()).toEqual({ ok: true });
      }, 20_000);

      it('does not sell a loan that is already liquidating', async () => {
        const opened = await openAt('5200');
        await sql`UPDATE bank.loans SET status = 'liquidating' WHERE id = ${opened.loan.id}`;

        const sweep = await sweepAt(now);
        expect(sweep.refused).toEqual([]);
        expect(saleCount()).toBe(0);
        expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`).toHaveLength(0);
        expect((await loans.loan(opened.loan.id)).status).toBe('liquidating');
      });

      it('does not sell when the loan is repaid or liquidated before the claim', async () => {
        for (const closed of ['repaid', 'liquidated'] as const) {
          loans = new LoanService(sql, ledger, {
            originationFeeBps: '0',
            priceSource: price('10000'),
            venue: marketMakerVenue(),
            marginCalls: { send: async () => undefined },
          });
          const opened = await openAt('5200');
          loans = new LoanService(sql, ledger, {
            originationFeeBps: '0',
            priceSource: price('5200'),
            venue: {
              quote: async () => {
                await sql`UPDATE bank.loans SET status = ${closed}::bank.loan_status WHERE id = ${opened.loan.id}`;
                return {
                  proceeds: amt('1300'),
                  buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
                };
              },
            },
            marginCalls: { send: async () => undefined },
          });

          const before = saleCount();
          const sweep = await sweepAt(now);
          expect(sweep.refused).toEqual([]);
          expect(saleCount()).toBe(before);
          expect(await sql`SELECT id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id}`).toHaveLength(0);
          expect((await loans.loan(opened.loan.id)).status).toBe(closed);
        }
      });

      it('finishes a pending rung that already has a ledger tx while the loan is liquidating', async () => {
        await fundReserve('USDT', '100000');
        await fund(BORROWER, 'BTC', '1');
        await fund(MM_SWEEP, 'USDT', '100000');
        await ledger.post({
          idempotencyKey: 'seed-mm-overlap-stored',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(MM_SWEEP, 'USDT'), direction: 'credit', amount: amt('100000') },
            { account: marketMaker('USDT'), direction: 'debit', amount: amt('100000') },
          ],
        });
        await fund(INSURANCE_FUNDER, 'USDT', '10000');
        await ledger.post({
          idempotencyKey: 'seed-ins-overlap-stored',
          module: 'test',
          reason: 'seed',
          entries: [
            { account: userAvailable(INSURANCE_FUNDER, 'USDT'), direction: 'credit', amount: amt('10000') },
            { account: insuranceFund('USDT'), direction: 'debit', amount: amt('10000') },
          ],
        });

        const product = await makeProduct({
          policy: { ...DEFAULT_LIQUIDATION_POLICY, maxTrancheBps: 10_000 },
        });
        const opened = await loans.open({
          productId: product.id,
          userId: BORROWER,
          collateralAmount: amt('1'),
          principal: amt('5000'),
          now,
        });
        const sold = await ledger.post(
          recipes.loanLiquidate({
            loanId: opened.loan.id,
            userId: BORROWER,
            tranche: 0,
            collateralAssetId: 'BTC',
            collateralSold: amt('1'),
            debtAssetId: 'USDT',
            proceeds: amt('1000'),
            principalRepaid: amt('1000'),
            interestRepaid: 0n,
            penalty: 0n,
            surplusToBorrower: 0n,
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
            markPrice: amt('10000'),
          }),
        );
        await sql`
          INSERT INTO bank.loan_liquidations (
            loan_id, tranche, ltv_bps, mark_price, grace_waived, collateral_sold, proceeds,
            principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
            ledger_tx_id, status
          ) VALUES (
            ${opened.loan.id}, 0, 9000, '10000'::numeric, true, '1'::numeric, '1000'::numeric,
            '1000'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '0'::numeric,
            ${sold.id}, 'pending'
          )
        `;
        await sql`UPDATE bank.loans SET status = 'liquidating' WHERE id = ${opened.loan.id}`;

        const laterQuote: LiquidationVenue = {
          quote: async () => ({
            proceeds: amt('100'),
            buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
          }),
        };
        loans = new LoanService(sql, ledger, {
          originationFeeBps: '0',
          priceSource: price('1'),
          venue: laterQuote,
          marginCalls: { send: async () => undefined },
        });

        const before = saleCount();
        const sweep = await sweepAt(now);
        expect(sweep.refused).toEqual([]);
        expect(saleCount()).toBe(before);
        const rows = await sql<Array<{ status: string; tranche: number; ledger_tx_id: string | null }>>`
          SELECT status, tranche, ledger_tx_id FROM bank.loan_liquidations WHERE loan_id = ${opened.loan.id} ORDER BY tranche
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('settled');
        expect(rows[0]!.tranche).toBe(0);
        expect(rows[0]!.ledger_tx_id).toBe(sold.id);
        expect((await ledger.getTxByKey(`bank.loan.liquidate:${opened.loan.id}:0`))!.id).toBe(sold.id);
        expect(await ledger.getTxByKey(`bank.loan.liquidate:${opened.loan.id}:1`)).toBeNull();
      });
    });

    // ── Reconciliation ───────────────────────────────────────────────────────

    it('the reserve identity holds: funded − badDebt == reserve + outstanding (independent)', async () => {
      await fundReserve('USDT', '100000');
      await fund(BORROWER, 'BTC', '1');
      const product = await makeProduct();
      await loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now });

      const r = await loans.reconcileReserve('USDT');
      expect(formatAmount(r.reserveBalance)).toBe('95000');
      expect(formatAmount(r.outstandingPrincipal)).toBe('5000');
      expect(formatAmount(r.funded)).toBe('100000');
      // B-02: funded is the bank funding table sum — independent of the ledger reserve.
      expect(r.independent).toBe(true);
      expect(formatAmount(r.drift)).toBe('0');
    });

    it('reconcileReserve reports independent drift when funding table and ledger disagree', async () => {
      await fundReserve('USDT', '50000');
      // Steal from the reserve without a funding row — drift must surface, not hide as 0.
      await ledger.post({
        idempotencyKey: `steal-reserve-${Math.random()}`,
        module: 'test',
        reason: 'adversarial-reserve-drain',
        entries: [
          { account: loanReserve('USDT'), direction: 'credit', amount: amt('1000') },
          { account: userAvailable(BORROWER, 'USDT'), direction: 'debit', amount: amt('1000') },
        ],
      });

      const r = await loans.reconcileReserve('USDT');
      expect(r.independent).toBe(true);
      expect(formatAmount(r.funded)).toBe('50000');
      expect(formatAmount(r.reserveBalance)).toBe('49000');
      expect(formatAmount(r.drift)).toBe('1000');
    });

    it('pending undrawn principal does not inflate outstanding (reserve never left)', async () => {
      // Reserve empty so open locks collateral and fails the draw — status pending.
      await fund(BORROWER, 'BTC', '1');
      const product = await makeProduct();
      await loans
        .open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now })
        .catch(() => undefined);

      const r = await loans.reconcileReserve('USDT');
      // No draw happened; outstanding must stay zero even though a loan row names 5000.
      expect(formatAmount(r.outstandingPrincipal)).toBe('0');
      expect(formatAmount(r.reserveBalance)).toBe('0');
      expect(formatAmount(r.funded)).toBe('0');
      expect(r.independent).toBe(true);
      expect(formatAmount(r.drift)).toBe('0');
    });

    it('a borrower can never see another borrower&apos;s loan through the service', async () => {
      await fundReserve('USDT', '100000');
      await fund(BORROWER, 'BTC', '1');
      const product = await makeProduct();
      await loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now });

      expect(await loans.loansOf(OTHER, 50)).toHaveLength(0);
      expect(await loans.loansOf(BORROWER, 50)).toHaveLength(1);
    });

    it('marks a portfolio, reporting the aggregate AND each loan on its own', async () => {
      await fundReserve('USDT', '100000');
      await fund(BORROWER, 'BTC', '2');
      const product = await makeProduct();
      await loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('5000'), now });
      await loans.open({ productId: product.id, userId: BORROWER, collateralAmount: amt('1'), principal: amt('1000'), now });

      const mark = await loans.markUser(BORROWER, now);
      expect(mark.loans).toHaveLength(2);
      // Portfolio LTV is 6000/20000 = 30%, well below either loan's own figure
      // for the first loan (50%). Both are reported, because aggregate health is
      // a warning signal and NOT authority to reach across to the other loan's
      // collateral — that pot is locked to `loan:<id>` in the ledger.
      expect(mark.portfolioLtvBps).toBe(3_000);
      expect(mark.loans.find((l) => l.ltvBps === 5_000)).toBeDefined();
    });
  });
});
