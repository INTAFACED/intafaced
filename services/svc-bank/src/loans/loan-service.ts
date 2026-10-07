import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  InsufficientFundsError,
  LedgerError,
  formatAmount,
  insuranceFund,
  loanCollateralAccount,
  loanReserve,
  marketMaker,
  parseAmount,
  recipes,
  userAvailable,
  type Amount,
  type AccountRef,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertLoanProductsListLimit } from '../catalog-list-limit.js';
import { assertLoansListLimit } from '../owner-list-limit.js';
import { assertLoanAccrueBatchLimit, assertLoanResumePendingLimit, assertLoanRiskSweepLimit } from '../job-batch-limit.js';
import { withMoneySpan } from '../tracing.js';
import {
  affiliateLegAfterLoanLiquidate,
  affiliateLegAfterLoanRepay,
  fireAffiliateAccrue,
  NoopAffiliateAccrue,
  type AffiliateAccruePort,
  type AffiliateBankFeeLeg,
} from '../affiliate-accrue.js';
import { fireAffiliatePayout, NoopAffiliatePayout, type AffiliatePayoutPort } from '../affiliate-payout.js';
import {
  DEFAULT_MARK_POLICY,
  assertAcceptableForLiquidation,
  acceptableForMarking,
  type MarkPolicy,
  type PriceSource,
  type QuotedMark,
} from './prices.js';
import {
  accrualDay,
  assertPolicyCoherent,
  dailyLoanInterest,
  daysToAccrue,
  describeLtv,
  ltvBps,
  markPortfolio,
  isMarginCallCured,
  planLiquidation,
  splitProceeds,
  type LiquidationPolicy,
  type Mark,
  type PortfolioMark,
} from './risk.js';

/**
 * LOANS (§8.1) — collateral lock, LTV marking, margin call, liquidation, accrual.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IF THE PROCESS DIES EXACTLY HERE, WHOSE FUNDS ARE STRANDED?
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The question this codebase asks everywhere, answered for every money path in
 * this file. `loans.test.ts` proves each row rather than trusting it.
 *
 * ── open(): lock, THEN draw ──────────────────────────────────────────────────
 *
 *   after the `loans` row, before the lock post
 *     Nothing has moved. A `pending` loan with no collateral event. Recovered by
 *     `resumePending`, which re-drives it; abandoned, it is a dead row.
 *
 *   after the collateral lock, before the draw
 *     THE INTERESTING ONE. The borrower's collateral is locked and they have no
 *     principal. Nothing is stranded in the platform's hands: the value is in
 *     `user/<id>/<asset>/collateral/loan:<id>` — an account the ledger says is
 *     theirs — and the reserve has not moved. `resumePending` either completes
 *     the draw (idempotent key, so a retry that raced the crash returns the same
 *     transaction) or `abandonPending` releases the collateral. Both paths end
 *     with the borrower whole.
 *
 *     THE REVERSE ORDER IS THE BUG. Draw-then-lock leaves the borrower holding
 *     spendable principal against no collateral, and no retry closes that window
 *     because they can spend inside it. That is why §8.1 names `collateralLock`
 *     first, and why this is two transactions instead of one convenient post.
 *
 *   after the draw, before the status flip to `active`
 *     `drawLedgerTxId` is set inside the same database transaction as the status,
 *     so this window does not exist. If the process dies after the ledger post
 *     but before the commit, the row stays `pending` and `resumePending` re-posts
 *     the SAME idempotency key — svc-ledger returns the original transaction, and
 *     the second attempt records it. The money moves once; the record catches up.
 *
 * ── accrue(): no money moves at all ─────────────────────────────────────────
 *
 *   A crash mid-run leaves the days it committed and not the days it did not.
 *   `unique(loan_id, accrual_date)` means a re-run charges each day exactly once,
 *   and the day list is derived from the LAST ACCRUED DAY rather than from a
 *   clock, so catching up three days and re-running are the same operation.
 *
 * ── repay(): claim row before the post ──────────────────────────────────────
 *
 *   Same shape as `transfer_executions`. The `pending` row is inserted, the
 *   ledger post runs, the row is marked `settled` with its tx id. A crash between
 *   leaves a `pending` row whose ledger key is deterministic, so re-driving finds
 *   the original transaction rather than making a second one. Nothing is stranded
 *   — the borrower's payment either happened or did not, and the row says which.
 *
 * ── liquidate(): the seizure and the sale are ONE transaction ───────────────
 *
 *   The three-step version — release collateral, sell it, apply the proceeds —
 *   has a window in which the borrower holds spendable collateral on a defaulting
 *   loan, and a borrower watching a liquidation notices. `loanLiquidate` posts
 *   the collateral leg and the debt leg together, so there is no instant at which
 *   either side holds value they have not paid for. A crash leaves a `pending`
 *   tranche row and a deterministic key; re-driving settles it once.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO BALANCE, AND NO OUTSTANDING COLUMN
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `outstanding()` below is a SQL aggregate over write-once rows, computed in
 * bigint, every time it is asked. It is never stored. The schema comments explain
 * why at length; the short version is that a mutable debt column written nightly
 * by a job is a figure nothing can contradict, and every liquidation decision
 * would be made from it.
 */

export interface LoanProductRecord {
  id: string;
  name: string;
  debtAssetId: string;
  collateralAssetId: string;
  quoteAssetId: string;
  aprBps: number;
  maxLtvBps: number;
  minPrincipal: Amount;
  policy: LiquidationPolicy;
  status: string;
}

export interface LoanRecord {
  id: string;
  productId: string;
  userId: string;
  debtAssetId: string;
  collateralAssetId: string;
  quoteAssetId: string;
  aprBps: number;
  principal: Amount;
  /**
   * Collateral pledged at open, snapshotted once — a TERM, not a live balance.
   * Live holdings are ledger + `loan_collateral_events`. Null only on legacy
   * rows opened before this column existed.
   */
  openingCollateral: Amount | null;
  status: 'pending' | 'active' | 'margin_call' | 'liquidating' | 'repaid' | 'liquidated';
  drawLedgerTxId: string | null;
  openedAt: Date;
  marginCalledAt: Date | null;
  lastMarkPrice: Amount | null;
  closedAt: Date | null;
}

export interface LoanDebt {
  /** Principal drawn, less principal repaid or recovered. */
  readonly principal: Amount;
  /** Interest capitalised, less interest paid or recovered. */
  readonly interest: Amount;
  /** The number every LTV is computed from. `principal + interest`. */
  readonly total: Amount;
}

/**
 * WHO BUYS SEIZED COLLATERAL — §8.1's "liquidation via internal book".
 *
 * A port, not a hardcoded account, because "the internal book" is a claim that
 * has to be true of something. The v1 implementation is the platform's own
 * market-maker account, which means the platform really pays for what it seizes
 * out of a balance that really falls — and a market maker with no cash cannot
 * absorb a liquidation, so the liquidation fails loudly instead of half-settling.
 *
 * What this is NOT: a walk down a real order book. Matching a liquidation against
 * resting orders needs svc-trade to accept an order funded from a `collateral`
 * pot, which is svc-trade's to build (see `prices.ts` for the full cross-stream
 * ask). Until then this is an atomic sale to a named counterparty at a marked
 * price — honest, and less than the spec's sentence promises.
 */
export interface LiquidationVenue {
  /**
   * Quote a sale of `collateralAmount` and name the accounts that will settle it.
   *
   * Returning `null` means nobody can take it, and a liquidation that cannot find
   * a buyer must not proceed — the alternative is booking a fictional sale.
   */
  quote(input: {
    loanId: string;
    collateralAssetId: string;
    collateralAmount: Amount;
    debtAssetId: string;
    markPrice: Amount;
  }): Promise<{ proceeds: Amount; buyer: { collateralTo: AccountRef; proceedsFrom: AccountRef } } | null>;
}

/**
 * The internal market maker takes the other side, at the mark.
 *
 * No slippage model, and that omission is stated rather than hidden: a real book
 * fills a large sale at progressively worse prices, which is exactly why
 * `maxTrancheBps` caps each rung. Sizing the cap against measured depth needs the
 * depth read that does not exist yet.
 */
export function marketMakerVenue(): LiquidationVenue {
  return {
    quote: async (input) => ({
      proceeds: (input.collateralAmount * input.markPrice) / parseAmount('1'),
      buyer: {
        collateralTo: marketMaker(input.collateralAssetId),
        proceedsFrom: marketMaker(input.debtAssetId),
      },
    }),
  };
}

/**
 * Delivery of a margin call.
 *
 * A port, so that RAISING a call and TELLING the borrower stay two separable
 * facts. The CALL is durable here — a `loan_margin_calls` row, and the grace
 * clock that gates liquidation reads from it — and DELIVERY is pluggable.
 *
 * The distinction matters and the schema keeps it: `notifiedAt` is separate from
 * `calledAt`, so a call that was raised but never delivered is visible as such
 * rather than indistinguishable from one the borrower read. A borrower disputing
 * a liquidation can be answered from these two columns.
 *
 * `eventMarginCallSink` (./margin-call-publisher.ts) is the implementation that
 * reaches the borrower, and it is what `index.ts` wires. It publishes
 * `bankMarginCalled` — the subject whose svc-notify consumer was complete and
 * parked on a publisher that did not exist, which is why this port existed and
 * delivered nothing for as long as it did.
 *
 * `sequence` and `calledAt` are on this input because the CONSUMER needs both:
 * `<loanId>:<sequence>` is the business key it dedupes on, and a consumer cannot
 * see a header it was not given.
 */
export interface MarginCallSink {
  send(input: {
    loanId: string;
    userId: string;
    /** Per-loan call number, from 1. Half of the business key. */
    sequence: number;
    ltvBps: number;
    cureCollateralAmount: Amount;
    collateralAssetId: string;
    /** When this call was raised — the same instant written to the row. */
    calledAt: Date;
    graceExpiresAt: Date;
  }): Promise<void>;
}

/**
 * Records the call and nothing else.
 *
 * The fallback for a deployment with no bus, and no longer the production
 * default — `index.ts` wires `eventMarginCallSink`. Kept because a service that
 * cannot reach NATS must still be able to raise and enforce a call: the grace
 * clock gating liquidation is a database fact, and making it depend on a message
 * broker would mean a broker outage silently stops calling loans that are
 * already past the threshold.
 *
 * Its one dishonesty, named here rather than left to be found: because `send`
 * resolves, `raiseMarginCall` writes `notified_at`, and under this sink that
 * timestamp records a handoff to nothing. It is accurate under the event sink,
 * where it records that JetStream accepted the publish — svc-notify records
 * per-channel delivery separately, and is allowed to answer "no".
 */
export const recordOnlyMarginCallSink: MarginCallSink = { send: async () => undefined };

export interface LoanServiceOptions {
  readonly priceSource: PriceSource;
  readonly venue?: LiquidationVenue;
  readonly marginCalls?: MarginCallSink;
  readonly markPolicy?: MarkPolicy;
  readonly daysPerYear?: number;
  /**
   * Module kill (`BANK_LOANS_ENABLED` / FLAG_REGISTRY bank.loans). Default true.
   * When false, `open` refuses `bank.loans_disabled`.
   */
  readonly moduleEnabled?: boolean;
  /**
   * Identity affiliate accrue after house bank fees post. Default noop.
   * Failures must not unwind loanRepay / loanLiquidate.
   */
  readonly affiliateAccrue?: AffiliateAccruePort;
  /**
   * Identity affiliate payout after accrue. Default noop. Failures must not
   * unwind the ledger post. Body is `{ feeEventId }` only.
   */
  readonly affiliatePayout?: AffiliatePayoutPort;
}

const ONE = parseAmount('1');

/** price × quantity, both scaled. Rounding is the caller's decision to state. */
function quoteValue(quantity: Amount, price: Amount, rounding: 'floor' | 'ceil'): Amount {
  const raw = quantity * price;
  if (rounding === 'floor') return raw / ONE;
  return (raw + ONE - 1n) / ONE;
}

export class LoanService {
  private readonly venue: LiquidationVenue;
  private readonly marginCalls: MarginCallSink;
  private readonly markPolicy: MarkPolicy;
  private readonly affiliateAccrue: AffiliateAccruePort;
  private readonly affiliatePayout: AffiliatePayoutPort;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly options: LoanServiceOptions,
  ) {
    this.venue = options.venue ?? marketMakerVenue();
    this.marginCalls = options.marginCalls ?? recordOnlyMarginCallSink;
    this.markPolicy = options.markPolicy ?? DEFAULT_MARK_POLICY;
    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = options.affiliatePayout ?? new NoopAffiliatePayout();
  }

  // ── Products ───────────────────────────────────────────────────────────────

  async createProduct(input: {
    name: string;
    debtAssetId: string;
    collateralAssetId: string;
    quoteAssetId: string;
    aprBps: number;
    maxLtvBps: number;
    minPrincipal?: Amount;
    policy: LiquidationPolicy;
  }): Promise<LoanProductRecord> {
    // Checked here as well as by the database CHECK, so the operator gets a
    // sentence about which threshold is wrong rather than a constraint name.
    assertPolicyCoherent(input.policy, input.maxLtvBps);

    if (input.debtAssetId === input.collateralAssetId) {
      throw new BankError(
        `A collateralised loan borrows one asset against another; both are ${input.debtAssetId}`,
        'bank.policy_incoherent',
      );
    }

    const rows = await this.sql<Array<Record<string, unknown>>>`
      INSERT INTO bank.loan_products (
        name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps,
        margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
        penalty_bps, max_tranche_bps, grace_seconds, min_principal
      ) VALUES (
        ${input.name}, ${input.debtAssetId}, ${input.collateralAssetId}, ${input.quoteAssetId},
        ${input.aprBps}, ${input.maxLtvBps}, ${input.policy.marginCallLtvBps}, ${input.policy.liquidationLtvBps},
        ${input.policy.insolvencyLtvBps}, ${input.policy.targetLtvBps}, ${input.policy.penaltyBps},
        ${input.policy.maxTrancheBps}, ${input.policy.graceSeconds},
        ${formatAmount(input.minPrincipal ?? 0n)}::numeric
      )
      RETURNING *
    `;
    return toProduct(rows[0]!);
  }

  async listProducts(assetId?: string, limit?: number): Promise<LoanProductRecord[]> {
    const page = assertLoanProductsListLimit(limit);
    const rows = assetId
      ? await this.sql<Array<Record<string, unknown>>>`
          SELECT * FROM bank.loan_products
           WHERE status = 'open' AND (debt_asset_id = ${assetId} OR collateral_asset_id = ${assetId})
           ORDER BY name ASC
           LIMIT ${page}`
      : await this.sql<Array<Record<string, unknown>>>`
          SELECT * FROM bank.loan_products WHERE status = 'open' ORDER BY name ASC
           LIMIT ${page}`;
    return rows.map(toProduct);
  }

  async product(id: string): Promise<LoanProductRecord> {
    const rows = await this.sql<Array<Record<string, unknown>>>`SELECT * FROM bank.loan_products WHERE id = ${id}`;
    if (rows.length === 0) throw new BankError(`No loan product ${id}`, 'bank.loan_product_not_found');
    return toProduct(rows[0]!);
  }

  // ── Reading a loan ─────────────────────────────────────────────────────────

  async loan(id: string): Promise<LoanRecord> {
    const rows = await this.sql<Array<Record<string, unknown>>>`SELECT * FROM bank.loans WHERE id = ${id}`;
    if (rows.length === 0) throw new BankError(`No loan ${id}`, 'bank.loan_not_found');
    return toLoan(rows[0]!);
  }

  async loansOf(userId: string, limit?: number): Promise<LoanRecord[]> {
    const page = assertLoansListLimit(limit);
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM bank.loans WHERE user_id = ${userId} ORDER BY opened_at DESC
       LIMIT ${page}
    `;
    return rows.map(toLoan);
  }

  /** Job work set — open book for markUser. Not a list page; mark is not milled as a dump. */
  private async openLoansForMark(userId: string): Promise<LoanRecord[]> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM bank.loans
       WHERE user_id = ${userId} AND status IN ('active', 'margin_call', 'liquidating')
       ORDER BY opened_at DESC
    `;
    return rows.map(toLoan);
  }

  /**
   * OUTSTANDING DEBT — derived, never stored.
   *
   * One aggregate over the write-once tables. The interest and principal legs are
   * kept apart all the way through because the liquidation waterfall settles
   * interest before principal, and a single blended figure could not express that
   * ordering — nor tell an auditor how much of a repayment was a charge and how
   * much was capital returning to the reserve.
   *
   * Clamped at zero rather than allowed to go negative. A negative debt would
   * mean the loan has been over-collected, which is a bug, and the honest
   * response is a zero here plus a shortfall of nothing — not a figure that would
   * quietly credit the borrower on the next repayment.
   */
  async outstanding(loanId: string, tx: Sql = this.sql): Promise<LoanDebt> {
    const rows = await tx<Array<{ principal: string; interest: string }>>`
      WITH drawn AS (
        SELECT principal FROM bank.loans WHERE id = ${loanId}
      ),
      accrued AS (
        SELECT COALESCE(SUM(interest_amount), 0) AS v
          FROM bank.loan_interest_accruals WHERE loan_id = ${loanId}
      ),
      repaid AS (
        SELECT COALESCE(SUM(principal_amount), 0) AS p, COALESCE(SUM(interest_amount), 0) AS i
          FROM bank.loan_repayments WHERE loan_id = ${loanId} AND status = 'settled'
      ),
      seized AS (
        -- Shortfall only reduces outstanding after insurance actually posted
        -- (bad_debt_ledger_tx_id set). Counting shortfall on settle-alone left
        -- a hole where loanLiquidate succeeded, loanBadDebt failed, and the next
        -- sweep saw debt.total = 0 and cleared the loan without charging insurance (B-01).
        SELECT COALESCE(SUM(principal_repaid), 0) AS p, COALESCE(SUM(interest_repaid), 0) AS i,
               COALESCE(SUM(
                 CASE
                   WHEN shortfall > 0 AND bad_debt_ledger_tx_id IS NOT NULL THEN shortfall
                   ELSE 0
                 END
               ), 0) AS s
          FROM bank.loan_liquidations WHERE loan_id = ${loanId} AND status = 'settled'
      )
      SELECT
        GREATEST((SELECT principal FROM drawn) - repaid.p - seized.p - seized.s, 0) AS principal,
        GREATEST(accrued.v - repaid.i - seized.i, 0) AS interest
        FROM accrued, repaid, seized
    `;

    if (rows.length === 0) throw new BankError(`No loan ${loanId}`, 'bank.loan_not_found');

    const principal = parseAmount(rows[0]!.principal);
    const interest = parseAmount(rows[0]!.interest);
    return { principal, interest, total: principal + interest };
  }

  /** Collateral held for this loan, read from the ledger. The only source. */
  async collateralOf(loan: LoanRecord): Promise<Amount> {
    const balance = await this.ledger.balance(loanCollateralAccount(loan.userId, loan.collateralAssetId, loan.id));
    return balance.amount;
  }

  // ── Opening a loan ─────────────────────────────────────────────────────────

  /**
   * OPEN A LOAN: lock collateral, then release principal. In that order, as two
   * transactions, for the reason in the file header.
   *
   * `loanId` is accepted from the caller so a retried request is the same loan
   * rather than a second one (§5: idempotency keys are business keys). A client
   * that times out and retries must not end up with two leveraged positions.
   */
  async open(input: {
    loanId?: string;
    productId: string;
    userId: string;
    collateralAmount: Amount;
    principal: Amount;
    now?: Date;
  }): Promise<{ loan: LoanRecord; ltvBps: number; collateralLedgerTxId: string; drawLedgerTxId: string }> {
    if (this.options.moduleEnabled === false) {
      throw new BankError('Loans module is disabled (BANK_LOANS_ENABLED / bank.loans)', 'bank.loans_disabled');
    }
    const now = input.now ?? new Date();
    const product = await this.product(input.productId);

    if (product.status !== 'open') throw new BankError(`Loan product "${product.name}" is closed`, 'bank.loan_product_closed');
    if (input.principal < product.minPrincipal) {
      throw new BankError(
        `Minimum draw for "${product.name}" is ${formatAmount(product.minPrincipal)} ${product.debtAssetId}`,
        'bank.below_minimum',
      );
    }
    if (input.principal <= 0n || input.collateralAmount <= 0n) {
      throw new BankError('A loan needs positive collateral and positive principal', 'bank.ltv_exceeded');
    }

    // ── Opening LTV, on marks that must pass the marking guards ──────────────
    // Not the liquidation guards: opening a loan is the borrower's own choice and
    // a slightly stale mark costs them nothing they did not ask for. The
    // difference matters in the other direction — a stale HIGH collateral mark
    // lets them over-borrow, so `maxLtvBps` sits well below the margin-call
    // threshold precisely to leave room for that error.
    const marks = await this.marksFor(product.collateralAssetId, product.debtAssetId, product.quoteAssetId, now);

    const collateralMark = marks.get(product.collateralAssetId)!;
    const debtMark = marks.get(product.debtAssetId)!;

    const debtValue = quoteValue(input.principal, debtMark.price, 'ceil');
    const collateralValue = quoteValue(input.collateralAmount, collateralMark.price, 'floor');
    const openingLtv = ltvBps(debtValue, collateralValue);

    if (openingLtv > product.maxLtvBps) {
      throw new BankError(
        `Opening LTV ${describeLtv(openingLtv)} exceeds the ${describeLtv(product.maxLtvBps)} limit for "${product.name}" — ` +
          `post more collateral or borrow less`,
        'bank.ltv_exceeded',
      );
    }

    // ── The row, before any money moves ─────────────────────────────────────
    //
    // The id is settled in TypeScript rather than by the database default, so the
    // INSERT is a fixed statement with `ON CONFLICT (id) DO NOTHING` in every
    // case. A caller-supplied id makes a retried request the same loan; a
    // generated one makes a fresh loan. Branching the SQL instead would give the
    // two paths different statements, and the retry path is the one that must not
    // have its own bugs.
    const loanId = input.loanId ?? randomUUID();

    const inserted = await this.sql<Array<Record<string, unknown>>>`
      INSERT INTO bank.loans (
        id, product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal, opening_collateral, opened_at
      ) VALUES (
        ${loanId}, ${product.id}, ${input.userId}, ${product.debtAssetId}, ${product.collateralAssetId},
        ${product.quoteAssetId}, ${product.aprBps}, ${formatAmount(input.principal)}::numeric,
        ${formatAmount(input.collateralAmount)}::numeric, ${now}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;

    const loan = inserted.length > 0 ? toLoan(inserted[0]!) : await this.loan(loanId);

    /**
     * THE RETRY MUST BE THE SAME LOAN, NOT JUST THE SAME ID.
     *
     * Order: who is asking → principal → opening collateral. Borrower first so a
     * second caller is not answered with the first loan's stored amounts via a
     * typed amount mismatch. Principal and collateral still refuse under-coll
     * and principal-swap attacks once identity matches.
     */
    if (loan.userId !== input.userId || loan.productId !== product.id) {
      throw new BankError(
        `Loan ${loan.id} already exists and was not opened by this request — a retry must carry the same terms. ` +
          `Use a new loan id to open a different loan`,
        'bank.loan_borrower_mismatch',
      );
    }

    if (loan.principal !== input.principal) {
      throw new BankError(
        `Loan ${loan.id} already exists with a principal of ${formatAmount(loan.principal)} ${loan.debtAssetId}, but this request asks for ` +
          `${formatAmount(input.principal)} — a retry must carry the same terms. Use a new loan id to borrow a different amount`,
        'bank.loan_principal_mismatch',
      );
    }

    const storedOpening =
      loan.openingCollateral ?? (await this.collateralEvent(loan.id, 0).then((e) => (e ? parseAmount(e.amount) : null)));
    if (storedOpening !== null && storedOpening !== input.collateralAmount) {
      throw new BankError(
        `Loan ${loan.id} already exists with opening collateral of ${formatAmount(storedOpening)} ${loan.collateralAssetId}, but this request asks for ` +
          `${formatAmount(input.collateralAmount)} — a retry must carry the same terms. Use a new loan id to pledge a different amount`,
        'bank.loan_collateral_mismatch',
      );
    }

    if (loan.status !== 'pending') {
      // A completed retry. Return what already exists rather than opening a
      // second position against the same collateral.
      const existing = await this.drawRecord(loan.id);
      return {
        loan,
        ltvBps: openingLtv,
        collateralLedgerTxId: existing.collateralLedgerTxId,
        drawLedgerTxId: existing.drawLedgerTxId,
      };
    }

    return this.completePending(loan, input.collateralAmount, openingLtv, now);
  }

  /**
   * Drive a `pending` loan to `active`: lock (once), then draw (once).
   *
   * Called by `open` and, after a crash, by `resumePending`. Both paths run the
   * same code with the same idempotency keys, which is the whole reason recovery
   * is not a separate code path with its own bugs.
   */
  private async completePending(
    loan: LoanRecord,
    collateralAmount: Amount,
    openingLtv: number,
    now: Date,
  ): Promise<{ loan: LoanRecord; ltvBps: number; collateralLedgerTxId: string; drawLedgerTxId: string }> {
    return withMoneySpan('bank.loan.open', { operation: 'loan-open', loanId: loan.id }, async (span) => {
      // ── STEP 1: COLLATERAL ────────────────────────────────────────────────
      // A crash after this and before step 2 leaves the borrower's collateral in
      // their OWN purposed ledger account with the reserve untouched. Nothing is
      // stranded in the platform's hands.
      let collateralTxId: string;
      try {
        collateralTxId = (await this.lockCollateral(loan, collateralAmount, 0, loan.id)).ledgerTxId;
      } catch (err) {
        if (isInsufficientFunds(err)) {
          // Borrower cannot fund the lock. Loan stays `pending` with no lock
          // committed to the ledger (or with a claimed event awaiting re-drive).
          // Typed as BankError so callers never see a raw ledger insufficient
          // bubble out of open() — and so a retry with DIFFERENT terms can hit
          // the principal-mismatch gate as a BankError rather than racing the
          // lock again under a ledger message that names nothing about terms.
          throw new BankError(
            `Borrower cannot lock ${formatAmount(collateralAmount)} ${loan.collateralAssetId} for loan ${loan.id}. ` +
              `The loan is pending; fund the collateral or abandon the pending row.`,
            'bank.loan_collateral_short',
          );
        }
        throw err;
      }

      // ── STEP 2: PRINCIPAL ─────────────────────────────────────────────────
      let drawTxId: string;
      try {
        const posted = await this.ledger.post(
          recipes.loanDraw({
            loanId: loan.id,
            userId: loan.userId,
            debtAssetId: loan.debtAssetId,
            principal: loan.principal,
          }),
        );
        drawTxId = posted.id;
      } catch (err) {
        if (isInsufficientFunds(err)) {
          // The RESERVE is short, not the borrower. Rethrown as its own code so
          // the alert says "the platform cannot lend" rather than blaming a user
          // who did everything right. The loan stays `pending` with its collateral
          // locked and recoverable — see `abandonPending`.
          throw new BankError(
            `The ${loan.debtAssetId} lending reserve cannot fund ${formatAmount(loan.principal)}. ` +
              `The loan is pending with collateral locked; release it or fund the reserve.`,
            'bank.loan_reserve_underfunded',
          );
        }
        throw err;
      }

      // Status and tx id commit together, so there is no window in which the
      // principal has moved and the row does not know.
      const updated = await this.sql<Array<Record<string, unknown>>>`
        UPDATE bank.loans
           SET status = 'active', draw_ledger_tx_id = ${drawTxId}, drawn_at = ${now},
               last_mark_price = ${null}, updated_at = now()
         WHERE id = ${loan.id} AND status = 'pending'
         RETURNING *
      `;

      span.setAttribute('intafaced.ltv_bps', openingLtv);

      return {
        loan: updated.length > 0 ? toLoan(updated[0]!) : await this.loan(loan.id),
        ltvBps: openingLtv,
        collateralLedgerTxId: collateralTxId,
        drawLedgerTxId: drawTxId,
      };
    });
  }

  /**
   * Re-drive every `pending` loan. The recovery path, and the answer to "the
   * process died between the lock and the draw".
   *
   * Safe to run at any time and any number of times: both posts are idempotent on
   * business keys, so a loan that got its collateral locked before the crash does
   * not lock it twice, and one that got its draw in does not draw twice.
   *
   * `limit` is required. Omit used to invent a 100-row pass. Blank refuses.
   * Owner/cron may pass 100 explicitly.
   */
  async resumePending(limit?: number): Promise<Array<{ loanId: string; outcome: 'completed' | 'failed'; reason?: string }>> {
    const batch = assertLoanResumePendingLimit(limit);
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM bank.loans WHERE status = 'pending' ORDER BY opened_at ASC LIMIT ${batch}
    `;

    const out: Array<{ loanId: string; outcome: 'completed' | 'failed'; reason?: string }> = [];

    for (const row of rows) {
      const loan = toLoan(row);
      try {
        const locked = await this.collateralEvent(loan.id, 0);
        if (!locked) {
          // The lock never landed. Nothing has moved anywhere, so this is not a
          // recovery — it is a loan that was never opened, and re-deriving the
          // collateral amount from a row that does not exist is not possible.
          out.push({ loanId: loan.id, outcome: 'failed', reason: 'no collateral event to resume from' });
          continue;
        }
        await this.completePending(loan, parseAmount(locked.amount), 0, new Date());
        out.push({ loanId: loan.id, outcome: 'completed' });
      } catch (err) {
        out.push({ loanId: loan.id, outcome: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return out;
  }

  /**
   * Give up on a `pending` loan and give the collateral back.
   *
   * The other half of the crash story. A loan stuck `pending` because the reserve
   * could not fund it must not hold the borrower's collateral indefinitely —
   * that IS stranding funds, just slowly. Refuses once the principal has been
   * drawn, because at that point the collateral is securing real debt.
   */
  async abandonPending(loanId: string): Promise<{ released: Amount; ledgerTxId: string | null }> {
    const loan = await this.loan(loanId);
    if (loan.status !== 'pending') {
      throw new BankError(
        `Loan ${loanId} is ${loan.status}, not pending — its collateral secures drawn principal`,
        'bank.loan_not_drawable',
      );
    }

    const held = await this.collateralOf(loan);
    if (held <= 0n) {
      await this.sql`UPDATE bank.loans SET status = 'repaid', closed_at = now(), updated_at = now() WHERE id = ${loanId}`;
      return { released: 0n, ledgerTxId: null };
    }

    const txId = await this.releaseCollateral(loan, held);
    await this.sql`UPDATE bank.loans SET status = 'repaid', closed_at = now(), updated_at = now() WHERE id = ${loanId}`;
    return { released: held, ledgerTxId: txId };
  }

  // ── Collateral movements ───────────────────────────────────────────────────

  /**
   * Add collateral to a live loan.
   *
   * The best outcome available to everyone when a loan is in margin call, and the
   * reason `loan_collateral_events` is keyed on (loan, sequence) rather than the
   * loan alone. Clearing the call is left to the next mark rather than done here:
   * curing is a question about a price, and this method does not have one.
   *
   * `eventId` is the client retry key (§5). Required: omit used to allocate MAX+1
   * and post a second loanCollateralLock. A minted UUID would be a fake key a
   * retry cannot reuse. Sequence is MAX+1 only for a *new* event. An overlapping
   * retry that loses `ON CONFLICT (id)` posts the claimed row's sequence — the
   * ledger key is loanId:sequence, so posting the caller's MAX+1 would lock twice.
   */
  async addCollateral(input: {
    loanId: string;
    eventId: string;
    amount: Amount;
    now?: Date;
  }): Promise<{ ledgerTxId: string; sequence: number }> {
    if (!input.eventId) {
      throw new BankError('eventId is required for a retry-safe collateral lock', 'bank.event_id_required');
    }
    const now = input.now ?? new Date();
    const loan = await this.loan(input.loanId);
    if (loan.status === 'repaid' || loan.status === 'liquidated') {
      throw new BankError(`Loan ${loan.id} is ${loan.status}`, 'bank.loan_closed');
    }
    if (input.amount <= 0n) throw new BankError('Collateral top-up must be positive', 'bank.below_minimum');

    await this.marksFor(loan.collateralAssetId, loan.debtAssetId, loan.quoteAssetId, now);

    const eventId = input.eventId;
    const existing = await this.collateralEventById(eventId);
    if (existing) {
      this.assertCollateralRetryMatches(loan, eventId, input.amount, existing);
      return this.lockCollateral(loan, input.amount, existing.sequence, eventId);
    }

    const sequence = await this.nextCollateralSequence(loan.id);
    return this.lockCollateral(loan, input.amount, sequence, eventId);
  }

  /**
   * Release excess collateral from a live loan through ledger-client.
   *
   * Marks first. A missing mark refuses `bank.mark_missing` before any release —
   * withdrawing against a book nobody priced is the same lie as originating on a
   * default. After-release LTV is computed from those marks and the product cap;
   * this method does not invent a rate. Curing is still the next mark's job.
   */
  async releaseExcess(input: { loanId: string; amount: Amount; now?: Date }): Promise<{ ledgerTxId: string; sequence: number }> {
    const now = input.now ?? new Date();
    const loan = await this.loan(input.loanId);
    if (loan.status === 'repaid' || loan.status === 'liquidated') {
      throw new BankError(`Loan ${loan.id} is ${loan.status}`, 'bank.loan_closed');
    }
    if (loan.status === 'pending') {
      throw new BankError(
        `Loan ${loan.id} is pending — abandon it rather than peeling collateral off an undrawn row`,
        'bank.loan_not_drawable',
      );
    }
    if (input.amount <= 0n) throw new BankError('Collateral release must be positive', 'bank.below_minimum');

    const marks = await this.marksFor(loan.collateralAssetId, loan.debtAssetId, loan.quoteAssetId, now);
    const product = await this.product(loan.productId);
    const debt = await this.outstanding(loan.id);
    const held = await this.collateralOf(loan);
    if (input.amount > held) {
      throw new BankError(
        `Loan ${loan.id} holds ${formatAmount(held)} ${loan.collateralAssetId}, not ${formatAmount(input.amount)}`,
        'bank.loan_collateral_short',
      );
    }

    const remaining = held - input.amount;
    const collateralMark = marks.get(loan.collateralAssetId)!;
    const debtMark = marks.get(loan.debtAssetId)!;
    const debtValue = quoteValue(debt.total, debtMark.price, 'ceil');
    const collateralValue = quoteValue(remaining, collateralMark.price, 'floor');
    const afterLtv = ltvBps(debtValue, collateralValue);
    if (afterLtv > product.maxLtvBps) {
      throw new BankError(
        `Release would put loan ${loan.id} at LTV ${describeLtv(afterLtv)} ` +
          `above the ${describeLtv(product.maxLtvBps)} limit for "${product.name}"`,
        'bank.ltv_exceeded',
      );
    }

    const sequence = await this.nextCollateralSequence(loan.id);
    const txId = await this.releaseCollateral(loan, input.amount, sequence);
    return { ledgerTxId: txId, sequence };
  }

  private assertCollateralRetryMatches(
    loan: LoanRecord,
    eventId: string,
    amount: Amount,
    existing: { loan_id: string; sequence: number; direction: string; amount: string },
  ): void {
    if (existing.loan_id !== loan.id) {
      throw new BankError(
        `Collateral event ${eventId} already exists on a different loan — a retry must carry the same terms`,
        'bank.loan_borrower_mismatch',
      );
    }
    if (existing.direction !== 'lock') {
      throw new BankError(
        `Collateral event ${eventId} is a ${existing.direction}, not a lock — a retry must carry the same terms`,
        'bank.loan_collateral_mismatch',
      );
    }
    if (parseAmount(existing.amount) !== amount) {
      throw new BankError(
        `Collateral event ${eventId} already exists for ${formatAmount(parseAmount(existing.amount))} ${loan.collateralAssetId}, but this request asks for ` +
          `${formatAmount(amount)} — a retry must carry the same terms. Use a new event id to post a different amount`,
        'bank.loan_collateral_mismatch',
      );
    }
  }

  private async lockCollateral(
    loan: LoanRecord,
    amount: Amount,
    sequence: number,
    eventId: string,
  ): Promise<{ ledgerTxId: string; sequence: number }> {
    // Overlap key = eventId. The ledger recipe keys on loanId:sequence, so a
    // loser of ON CONFLICT (id) must post the claimed row's sequence, not the
    // MAX+1 it allocated before the winner's insert was visible.
    let postSequence = sequence;
    const ledgerTxId = await this.drivenPost({
      claim: async (tx) => {
        const rows = await tx<
          Array<{ id: string; sequence: number; ledger_tx_id: string | null; amount: string; direction: string; loan_id: string }>
        >`
          INSERT INTO bank.loan_collateral_events (id, loan_id, sequence, direction, amount)
          VALUES (${eventId}, ${loan.id}, ${sequence}, 'lock', ${formatAmount(amount)}::numeric)
          ON CONFLICT (id) DO NOTHING
          RETURNING id, sequence, ledger_tx_id, amount, direction, loan_id
        `;
        if (rows.length > 0) {
          postSequence = Number(rows[0]!.sequence);
          return { claimed: true as const, id: rows[0]!.id };
        }
        const existing = await tx<
          Array<{ id: string; sequence: number; ledger_tx_id: string | null; amount: string; direction: string; loan_id: string }>
        >`
          SELECT id, sequence, ledger_tx_id, amount, direction, loan_id
            FROM bank.loan_collateral_events WHERE id = ${eventId}
        `;
        const row = existing[0]!;
        this.assertCollateralRetryMatches(loan, eventId, amount, row);
        postSequence = Number(row.sequence);
        return { claimed: false as const, id: row.id, ledgerTxId: row.ledger_tx_id };
      },
      post: () =>
        this.ledger.post(
          recipes.loanCollateralLock({
            loanId: loan.id,
            userId: loan.userId,
            collateralAssetId: loan.collateralAssetId,
            amount,
            sequence: postSequence,
          }),
        ),
      table: 'loan_collateral_events',
    });
    return { ledgerTxId, sequence: postSequence };
  }

  private async releaseCollateral(loan: LoanRecord, amount: Amount, sequence?: number): Promise<string> {
    const seq = sequence ?? (await this.nextCollateralSequence(loan.id));
    return this.drivenPost({
      claim: async (tx) => {
        const rows = await tx<Array<{ id: string; ledger_tx_id: string | null }>>`
          INSERT INTO bank.loan_collateral_events (loan_id, sequence, direction, amount)
          VALUES (${loan.id}, ${seq}, 'release', ${formatAmount(amount)}::numeric)
          ON CONFLICT (loan_id, sequence) DO NOTHING
          RETURNING id, ledger_tx_id
        `;
        if (rows.length > 0) return { claimed: true as const, id: rows[0]!.id };
        const existing = await tx<Array<{ id: string; ledger_tx_id: string | null }>>`
          SELECT id, ledger_tx_id FROM bank.loan_collateral_events WHERE loan_id = ${loan.id} AND sequence = ${seq}
        `;
        return { claimed: false as const, id: existing[0]!.id, ledgerTxId: existing[0]!.ledger_tx_id };
      },
      post: () =>
        this.ledger.post(
          recipes.loanCollateralRelease({
            loanId: loan.id,
            userId: loan.userId,
            collateralAssetId: loan.collateralAssetId,
            amount,
            sequence: seq,
          }),
        ),
      table: 'loan_collateral_events',
    });
  }

  // ── Interest accrual ───────────────────────────────────────────────────────

  /**
   * ACCRUE ONE LOAN, for every day it owes and no day twice.
   *
   * ── Idempotency, which is the entire point ──────────────────────────────
   *
   * `unique(loan_id, accrual_date)` is the guard, and it is a DATABASE guard
   * rather than a ledger idempotency key because accrual moves no value: there is
   * no post to deduplicate. A crashed run that comes back re-derives the day list
   * from `MAX(accrual_date)`, so it charges exactly the days it has not charged.
   * Catching up three days and re-running yesterday are the same operation and
   * take the same path.
   *
   * ── Compounding, done one day at a time ────────────────────────────────
   *
   * Each day is computed on the debt as at the END of the previous day, which is
   * what makes it compound, and each day's basis is snapshotted in its own row.
   * The loop recomputes the running debt in bigint rather than re-querying, so a
   * three-day catch-up produces exactly the figures three separate nightly runs
   * would have — the borrower cannot be charged more or less for the platform
   * having been down.
   */
  async accrue(input: { loanId: string; until?: Date }): Promise<{
    loanId: string;
    days: Array<{ date: string; interest: Amount; basis: Amount; alreadyAccrued: boolean }>;
    charged: Amount;
  }> {
    const until = input.until ?? new Date();
    const loan = await this.loan(input.loanId);

    if (loan.status === 'repaid' || loan.status === 'liquidated') {
      return { loanId: loan.id, days: [], charged: 0n };
    }
    if (loan.status === 'pending') {
      // Un-drawn principal is not borrowed money. Charging interest on it would
      // bill a borrower for a loan the platform failed to fund.
      return { loanId: loan.id, days: [], charged: 0n };
    }

    const last = await this.sql<Array<{ d: string | null }>>`
      SELECT MAX(accrual_date)::text AS d FROM bank.loan_interest_accruals WHERE loan_id = ${loan.id}
    `;
    const days = daysToAccrue(last[0]?.d ?? null, loan.openedAt, until);
    if (days.length === 0) return { loanId: loan.id, days: [], charged: 0n };

    const results: Array<{ date: string; interest: Amount; basis: Amount; alreadyAccrued: boolean }> = [];
    let charged = 0n;

    // Running debt, carried in bigint through the loop so a catch-up compounds
    // day by day exactly as nightly runs would have.
    let debt = (await this.outstanding(loan.id)).total;

    for (const day of days) {
      const interest = dailyLoanInterest(debt, loan.aprBps, this.options.daysPerYear);

      // Zero-interest days are still WRITTEN. A day with no row would be
      // re-derived and re-charged forever by the next run, and on a dust loan
      // that means the day list grows without bound.
      const rows = await this.sql<Array<{ id: string }>>`
        INSERT INTO bank.loan_interest_accruals (loan_id, accrual_date, rate_bps, principal_basis, interest_amount)
        VALUES (${loan.id}, ${day}, ${loan.aprBps}, ${formatAmount(debt)}::numeric, ${formatAmount(interest)}::numeric)
        ON CONFLICT (loan_id, accrual_date) DO NOTHING
        RETURNING id
      `;

      if (rows.length === 0) {
        // THE GUARD FIRING. Another runner already charged this day, or this
        // runner is a retry of one that crashed after committing it. Either way
        // the day is charged once; we read what was actually charged so the
        // running debt stays true to the rows rather than to our arithmetic.
        const existing = await this.sql<Array<{ interest_amount: string }>>`
          SELECT interest_amount FROM bank.loan_interest_accruals WHERE loan_id = ${loan.id} AND accrual_date = ${day}
        `;
        const actual = parseAmount(existing[0]!.interest_amount);
        debt += actual;
        results.push({ date: day, interest: actual, basis: debt - actual, alreadyAccrued: true });
        continue;
      }

      debt += interest;
      charged += interest;
      results.push({ date: day, interest, basis: debt - interest, alreadyAccrued: false });
    }

    return { loanId: loan.id, days: results, charged };
  }

  /**
   * Every open loan accrues. The job's entry point.
   *
   * One loan that cannot accrue (bad row, transient fault) must not stop the
   * rest of the book. Failures are returned for the operator, not swallowed —
   * same isolation posture as `runRiskSweep` and earn `accrueAll`.
   *
   * `limit` is required. Omit used to invent a 1000-row pass. Blank refuses.
   * Owner/cron may pass 1000 explicitly.
   */
  async accrueAll(
    until: Date = new Date(),
    limit?: number,
  ): Promise<{
    results: Array<{ loanId: string; charged: Amount; days: number }>;
    failures: Array<{ loanId: string; reason: string; code?: string }>;
  }> {
    const batch = assertLoanAccrueBatchLimit(limit);
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM bank.loans WHERE status IN ('active', 'margin_call', 'liquidating') ORDER BY opened_at ASC LIMIT ${batch}
    `;
    const results: Array<{ loanId: string; charged: Amount; days: number }> = [];
    const failures: Array<{ loanId: string; reason: string; code?: string }> = [];
    for (const row of rows) {
      try {
        const result = await this.accrue({ loanId: row.id, until });
        results.push({ loanId: row.id, charged: result.charged, days: result.days.length });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const code = err instanceof BankError ? err.code : undefined;
        failures.push({ loanId: row.id, reason, ...(code ? { code } : {}) });
      }
    }
    return { results, failures };
  }

  // ── Repayment ──────────────────────────────────────────────────────────────

  /**
   * REPAY, interest first.
   *
   * Interest before principal, matching the liquidation waterfall, so a borrower
   * cannot pay down cheap principal while an interest balance compounds behind it.
   *
   * `amount` is what the borrower offers; the split is computed, not supplied. A
   * caller that could nominate the split could nominate "all principal" and leave
   * the interest to grow.
   *
   * `eventId` is the caller-stable retry key (same shape as addCollateral).
   * Omit used to allocate a new sequence so a retried repay posted twice.
   * Sequence is MAX+1 only for a *new* event. An overlapping retry that loses
   * `ON CONFLICT (id)` posts the claimed row's sequence — the ledger key is
   * loanId:sequence.
   */
  async repay(input: { loanId: string; amount: Amount; eventId: string; now?: Date }): Promise<{
    ledgerTxId: string;
    sequence: number;
    interestPaid: Amount;
    principalPaid: Amount;
    remaining: LoanDebt;
    closed: boolean;
  }> {
    if (!input.eventId) {
      throw new BankError('Loan repay needs a caller-stable event id', 'bank.repayment_id_required');
    }
    const now = input.now ?? new Date();
    const loan = await this.loan(input.loanId);
    const eventId = input.eventId;

    const prior = await this.repaymentById(eventId);
    if (prior) {
      if (prior.loan_id !== loan.id) {
        throw new BankError(
          `Repayment ${eventId} already exists on a different loan — a retry must carry the same terms`,
          'bank.loan_borrower_mismatch',
        );
      }
      if (prior.ledger_tx_id) {
        const remaining = await this.outstanding(loan.id);
        return {
          ledgerTxId: prior.ledger_tx_id,
          sequence: Number(prior.sequence),
          interestPaid: parseAmount(prior.interest_amount),
          principalPaid: parseAmount(prior.principal_amount),
          remaining,
          closed: remaining.total <= 0n || loan.status === 'repaid' || loan.status === 'liquidated',
        };
      }
    }

    if (loan.status === 'repaid' || loan.status === 'liquidated')
      throw new BankError(`Loan ${loan.id} is ${loan.status}`, 'bank.loan_closed');
    if (loan.status === 'pending') throw new BankError(`Loan ${loan.id} has no drawn principal to repay`, 'bank.loan_not_drawable');
    if (loan.status === 'liquidating')
      throw new BankError(`Loan ${loan.id} is mid-liquidation — wait for insurance cover / sweep before repay`, 'bank.loan_liquidating');
    if (input.amount <= 0n) throw new BankError('A repayment must be positive', 'bank.below_minimum');

    // Open shortfall rows mean insurance (or a re-drive) still owns the residual debt.
    // Allowing repay here dual-covers the hole with the borrower (critic B-01 residual).
    if (await this.hasOpenShortfall(loan.id)) {
      throw new BankError(`Loan ${loan.id} has uncovered liquidation shortfall — insurance re-drive required`, 'bank.loan_liquidating');
    }

    let interestPaid: Amount;
    let principalPaid: Amount;
    let sequence: number;
    if (prior) {
      interestPaid = parseAmount(prior.interest_amount);
      principalPaid = parseAmount(prior.principal_amount);
      sequence = Number(prior.sequence);
    } else {
      const debt = await this.outstanding(loan.id);
      if (debt.total <= 0n) {
        throw new BankError(`Loan ${loan.id} has nothing outstanding — release its collateral instead`, 'bank.loan_closed');
      }

      // Never take more than is owed. Overpayment is refused rather than absorbed:
      // the surplus would sit in `houseFees` or the reserve with no record that it
      // is the borrower's, which is exactly the shape of a balance held outside the
      // ledger's account model.
      const pay = input.amount > debt.total ? debt.total : input.amount;

      interestPaid = pay < debt.interest ? pay : debt.interest;
      principalPaid = pay - interestPaid;
      sequence = await this.nextSequence('loan_repayments', loan.id);
    }

    let postSequence = sequence;
    const ledgerTxId = await this.drivenPost({
      claim: async (tx) => {
        const rows = await tx<Array<{ id: string; sequence: number; ledger_tx_id: string | null }>>`
          INSERT INTO bank.loan_repayments (id, loan_id, sequence, interest_amount, principal_amount)
          VALUES (${eventId}, ${loan.id}, ${sequence}, ${formatAmount(interestPaid)}::numeric, ${formatAmount(principalPaid)}::numeric)
          ON CONFLICT (id) DO NOTHING
          RETURNING id, sequence, ledger_tx_id
        `;
        if (rows.length > 0) {
          postSequence = Number(rows[0]!.sequence);
          return { claimed: true as const, id: rows[0]!.id };
        }
        const existing = await tx<Array<{ id: string; sequence: number; ledger_tx_id: string | null }>>`
          SELECT id, sequence, ledger_tx_id FROM bank.loan_repayments WHERE id = ${eventId}
        `;
        postSequence = Number(existing[0]!.sequence);
        return { claimed: false as const, id: existing[0]!.id, ledgerTxId: existing[0]!.ledger_tx_id };
      },
      post: () =>
        this.ledger.post(
          recipes.loanRepay({
            loanId: loan.id,
            userId: loan.userId,
            debtAssetId: loan.debtAssetId,
            principal: principalPaid,
            interest: interestPaid,
            sequence: postSequence,
          }),
        ),
      table: 'loan_repayments',
    });

    await this.notifyBankAffiliateAccrue(
      affiliateLegAfterLoanRepay({
        loanId: loan.id,
        borrowerId: loan.userId,
        sequence: postSequence,
        interest: interestPaid,
        debtAssetId: loan.debtAssetId,
      }),
    );
    await this.notifyBankAffiliatePayout(
      affiliateLegAfterLoanRepay({
        loanId: loan.id,
        borrowerId: loan.userId,
        sequence: postSequence,
        interest: interestPaid,
        debtAssetId: loan.debtAssetId,
      }),
    );

    const remaining = await this.outstanding(loan.id);

    // ── SETTLEMENT: the debt is clear, so the collateral goes back ───────────
    // The ONE precondition that matters most in this module. `loanCollateralRelease`
    // cannot check it — a recipe has no reading of the loan — so it is checked
    // here, from a figure derived after the repayment has settled.
    let closed = false;
    if (remaining.total <= 0n) {
      const held = await this.collateralOf(loan);
      if (held > 0n) await this.releaseCollateral(loan, held);
      await this.sql`
        UPDATE bank.loans SET status = 'repaid', margin_called_at = NULL, closed_at = ${now}, updated_at = now()
         WHERE id = ${loan.id}
      `;
      await this.clearMarginCalls(loan.id, now);
      closed = true;
    }

    return { ledgerTxId, sequence: postSequence, interestPaid, principalPaid, remaining, closed };
  }

  /**
   * SEIZE one underwater loan through ledger-client.
   *
   * Marks first. A missing mark refuses `bank.mark_missing` before any post —
   * a zero default would read as no collateral and liquidate. The split is
   * computed from outstanding and the mark; the caller cannot nominate a rate.
   *
   * Not a user door. Operator surface (`ops.seizeLoan`) so the borrower cannot
   * choose the instant their own collateral is marked.
   */
  async seize(input: { loanId: string; now?: Date }): Promise<{
    ledgerTxId: string;
    collateralSold: Amount;
    proceeds: Amount;
    principalRepaid: Amount;
    interestRepaid: Amount;
    closed: boolean;
  }> {
    if (this.options.moduleEnabled === false) {
      throw new BankError('Loans module is disabled (BANK_LOANS_ENABLED / bank.loans)', 'bank.loans_disabled');
    }
    const now = input.now ?? new Date();
    const loan = await this.loan(input.loanId);

    if (loan.status === 'repaid' || loan.status === 'liquidated') {
      throw new BankError(`Loan ${loan.id} is ${loan.status}`, 'bank.loan_closed');
    }
    if (loan.status === 'pending') {
      throw new BankError(`Loan ${loan.id} has no drawn principal to seize`, 'bank.loan_not_drawable');
    }

    const product = await this.product(loan.productId);
    const marks = await this.marksFor(loan.collateralAssetId, loan.debtAssetId, loan.quoteAssetId, now);
    const collateralMark = marks.get(loan.collateralAssetId)!;
    const debtMark = marks.get(loan.debtAssetId)!;

    const debt = await this.outstanding(loan.id);
    const collateral = await this.collateralOf(loan);

    if (debt.total <= 0n) {
      throw new BankError(`Loan ${loan.id} has nothing outstanding — release its collateral instead`, 'bank.loan_closed');
    }

    const rung = planLiquidation({
      debt: debt.total,
      debtMark,
      collateral,
      collateralMark,
      policy: product.policy,
      marginCalledAt: loan.marginCalledAt,
      now,
    });

    if (rung.action !== 'liquidate') {
      throw new BankError(`Loan ${loan.id} is not seizable at this mark (LTV ${rung.ltvBps} bps)`, 'bank.margin_call_required');
    }

    assertAcceptableForLiquidation(collateralMark, loan.lastMarkPrice, now, this.markPolicy);

    await this.liquidateTranche({
      loan,
      product,
      ltv: rung.ltvBps,
      graceWaived: rung.graceWaived,
      collateralToSell: rung.collateralToSell,
      closesPosition: rung.closesPosition,
      collateralMark,
      debt,
      now,
    });

    const rows = await this.sql<
      Array<{
        ledger_tx_id: string | null;
        collateral_sold: string;
        proceeds: string;
        principal_repaid: string;
        interest_repaid: string;
      }>
    >`
      SELECT ledger_tx_id, collateral_sold, proceeds, principal_repaid, interest_repaid
        FROM bank.loan_liquidations
       WHERE loan_id = ${loan.id} AND status = 'settled'
       ORDER BY tranche DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row?.ledger_tx_id) {
      throw new BankError(`Loan ${loan.id} seize posted no liquidation`, 'bank.no_liquidation_counterparty');
    }
    const closed = (await this.loan(loan.id)).status === 'liquidated';
    return {
      ledgerTxId: row.ledger_tx_id,
      collateralSold: parseAmount(row.collateral_sold),
      proceeds: parseAmount(row.proceeds),
      principalRepaid: parseAmount(row.principal_repaid),
      interestRepaid: parseAmount(row.interest_repaid),
      closed,
    };
  }

  /**
   * Release collateral on a loan that owes nothing.
   *
   * Separate from `repay` because a loan can reach zero debt by liquidation too,
   * and because the refusal below is worth having its own name in a log.
   */
  async releaseSettled(loanId: string): Promise<{ released: Amount; ledgerTxId: string | null }> {
    const loan = await this.loan(loanId);
    const debt = await this.outstanding(loan.id);

    if (debt.total > 0n) {
      throw new BankError(
        `Loan ${loan.id} still owes ${formatAmount(debt.total)} ${loan.debtAssetId} — releasing its collateral now would ` +
          `convert a secured position into an unsecured one, and there is no posting that undoes it once the borrower withdraws`,
        'bank.loan_not_settled',
      );
    }

    const held = await this.collateralOf(loan);
    if (held <= 0n) return { released: 0n, ledgerTxId: null };

    const txId = await this.releaseCollateral(loan, held);
    await this.sql`
      UPDATE bank.loans SET status = 'repaid', closed_at = COALESCE(closed_at, now()), updated_at = now() WHERE id = ${loanId}
    `;
    return { released: held, ledgerTxId: txId };
  }

  // ── Marking, margin calls, liquidation ─────────────────────────────────────

  /**
   * MARK ONE USER'S PORTFOLIO (§8.1's "portfolio-aware LTV job").
   *
   * Read-only. It marks and reports; it does not act. Acting is `runRiskSweep`,
   * and keeping them apart means an operator can ask "what does the book look
   * like" without any chance of the question liquidating somebody.
   */
  async markUser(userId: string, now: Date = new Date()): Promise<PortfolioMark> {
    const loans = await this.openLoansForMark(userId);
    if (loans.length === 0) return { debtValue: 0n, collateralValue: 0n, portfolioLtvBps: 0, loans: [] };

    const quote = loans[0]!.quoteAssetId;
    const assets = new Set<string>();
    for (const loan of loans) {
      assets.add(loan.collateralAssetId);
      assets.add(loan.debtAssetId);
    }

    const marks = await this.acceptedMarks([...assets], quote, now);

    const exposures = await Promise.all(
      loans.map(async (loan) => ({
        loanId: loan.id,
        debtAssetId: loan.debtAssetId,
        debt: (await this.outstanding(loan.id)).total,
        collateralAssetId: loan.collateralAssetId,
        collateral: await this.collateralOf(loan),
      })),
    );

    return markPortfolio(exposures, marks as ReadonlyMap<string, Mark>);
  }

  /**
   * THE RISK SWEEP — mark every open loan and act on what it finds.
   *
   * ── The ordering guarantee, enforced here ───────────────────────────────
   *
   * `planLiquidation` returns `margin-call` rather than `liquidate` whenever
   * `marginCalledAt` is null or its grace has not expired, so the FIRST mark that
   * crosses the liquidation threshold raises a call and nothing else. Only a later
   * mark, after grace, can liquidate. The single exception is the insolvency
   * threshold, which waives grace and records `graceWaived` on the tranche so the
   * one case that breaks the rule is auditable per event.
   *
   * ── Why liquidation gets a stricter mark than marking ───────────────────
   *
   * A margin call on a doubtful mark costs the borrower a notification. A
   * liquidation on a doubtful mark costs them their collateral. So a loan whose
   * mark fails `acceptableForLiquidation` — stale, deviating through the breaker,
   * or derived from a single trade print rather than a two-sided quote — is
   * reported as `mark-refused` and left in margin call for an operator. That is a
   * real cost: a genuine crash liquidates one interval later. It is smaller than
   * liquidating the whole book on a spoofed print.
   */
  async runRiskSweep(input: { now?: Date; limit?: number } = {}): Promise<{
    marked: number;
    called: number;
    liquidated: number;
    cleared: number;
    refused: Array<{ loanId: string; reason: string }>;
  }> {
    const now = input.now ?? new Date();
    const limit = assertLoanRiskSweepLimit(input.limit);
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM bank.loans
       WHERE status IN ('active', 'margin_call', 'liquidating')
       ORDER BY opened_at ASC LIMIT ${limit}
    `;

    let marked = 0;
    let called = 0;
    let liquidated = 0;
    let cleared = 0;
    const refused: Array<{ loanId: string; reason: string }> = [];

    for (const row of rows) {
      const loan = toLoan(row);
      try {
        const outcome = await this.markAndAct(loan, now);
        marked++;
        if (outcome === 'called') called++;
        if (outcome === 'liquidated') liquidated++;
        if (outcome === 'cleared') cleared++;
      } catch (err) {
        // One bad mark must not stop the sweep. A loan that cannot be marked is
        // reported and left alone — the wrong action on a broken price is worse
        // than no action, and the next sweep tries again.
        refused.push({ loanId: loan.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return { marked, called, liquidated, cleared, refused };
  }

  private async markAndAct(loan: LoanRecord, now: Date): Promise<'none' | 'called' | 'liquidated' | 'cleared'> {
    const product = await this.product(loan.productId);
    const marks = await this.marksFor(loan.collateralAssetId, loan.debtAssetId, loan.quoteAssetId, now);
    const collateralMark = marks.get(loan.collateralAssetId)!;
    const debtMark = marks.get(loan.debtAssetId)!;

    // Re-drive insurance posts that failed after a settled liquidate (B-01).
    await this.coverOpenShortfalls(loan);

    const debt = await this.outstanding(loan.id);
    const collateral = await this.collateralOf(loan);

    if (debt.total <= 0n) {
      // Fully recovered — including after coverOpenShortfalls stamped insurance.
      // If any liquidate row settled, close as liquidated (not stuck `liquidating`).
      const liq = await this.sql<Array<{ n: string }>>`
        SELECT COUNT(*)::text AS n FROM bank.loan_liquidations
         WHERE loan_id = ${loan.id} AND status = 'settled'
      `;
      if (Number(liq[0]?.n ?? 0) > 0) {
        const held = await this.collateralOf(loan);
        if (held > 0n) await this.releaseCollateral(loan, held);
        await this.sql`
          UPDATE bank.loans
             SET status = 'liquidated', closed_at = COALESCE(closed_at, ${now}),
                 margin_called_at = NULL, updated_at = now()
           WHERE id = ${loan.id}
        `;
      } else {
        await this.sql`UPDATE bank.loans SET margin_called_at = NULL, updated_at = now() WHERE id = ${loan.id}`;
      }
      await this.clearMarginCalls(loan.id, now);
      return 'cleared';
    }

    const rung = planLiquidation({
      debt: debt.total,
      debtMark,
      collateral,
      collateralMark,
      policy: product.policy,
      marginCalledAt: loan.marginCalledAt,
      now,
    });

    // The accepted mark is recorded whatever happens next: it is the baseline the
    // deviation breaker measures the NEXT mark against, so skipping it on a quiet
    // day would leave the breaker comparing against an ancient price.
    await this.sql`
      UPDATE bank.loans
         SET last_mark_price = ${formatAmount(collateralMark.price)}::numeric, last_marked_at = ${now}, updated_at = now()
       WHERE id = ${loan.id}
    `;

    if (rung.action === 'none') {
      // `none` means either LTV recovered (real cure) OR collateral is exhausted
      // with residual debt still outstanding. Only the first may clear to active.
      // See `isMarginCallCured` / honesty residual: full coll sale with unpaid
      // interest must not false-cure to healthy active with zero collateral.
      if (
        isMarginCallCured({
          ladderAction: rung.action,
          debt: debt.total,
          collateral,
          marginCalledAt: loan.marginCalledAt,
        })
      ) {
        // CURED. The borrower posted collateral, or repaid, or the market came
        // back. Clearing the call resets the grace clock, which is correct: a
        // borrower who cured is entitled to a fresh warning and a fresh hour
        // before anything of theirs is sold.
        await this.sql`
          UPDATE bank.loans SET status = 'active', margin_called_at = NULL, updated_at = now() WHERE id = ${loan.id}
        `;
        await this.clearMarginCalls(loan.id, now);
        return 'cleared';
      }
      // Residual claim with no collateral left: stay non-active (margin_call /
      // liquidating). Borrower can still repay interest; do not report healthy.
      if (debt.total > 0n && collateral <= 0n && loan.status !== 'margin_call' && loan.status !== 'liquidating') {
        await this.sql`
          UPDATE bank.loans SET status = 'margin_call', updated_at = now() WHERE id = ${loan.id}
        `;
      }
      return 'none';
    }

    if (rung.action === 'margin-call') {
      await this.raiseMarginCall(loan, product, rung.ltvBps, debt.total, collateral, collateralMark, debtMark, now);
      return 'called';
    }

    // ── Liquidating. A stricter mark applies from here down. ────────────────
    assertAcceptableForLiquidation(collateralMark, loan.lastMarkPrice, now, this.markPolicy);

    await this.liquidateTranche({
      loan,
      product,
      ltv: rung.ltvBps,
      graceWaived: rung.graceWaived,
      collateralToSell: rung.collateralToSell,
      closesPosition: rung.closesPosition,
      collateralMark,
      debt,
      now,
    });

    return 'liquidated';
  }

  /**
   * Raise (or refresh) a margin call.
   *
   * A new row per call, and `marginCalledAt` set only if it is not already —
   * refreshing the figure must NOT restart the grace clock, or a borrower could
   * be kept perpetually one tick from expiry while the platform's exposure grew.
   *
   * `cureCollateralAmount` is what the borrower must post to get back to the
   * product's target, quoted at this mark and rounded UP so posting exactly that
   * much actually clears the call rather than landing a unit short.
   */
  private async raiseMarginCall(
    loan: LoanRecord,
    product: LoanProductRecord,
    ltv: number,
    debt: Amount,
    collateral: Amount,
    collateralMark: QuotedMark,
    debtMark: QuotedMark,
    now: Date,
  ): Promise<void> {
    const debtValue = quoteValue(debt, debtMark.price, 'ceil');
    const target = BigInt(product.policy.targetLtvBps);

    // Collateral value needed for target LTV: V = debtValue * 10000 / target.
    const neededValue = (debtValue * 10_000n + target - 1n) / target;
    const haveValue = quoteValue(collateral, collateralMark.price, 'floor');
    const shortValue = neededValue > haveValue ? neededValue - haveValue : 0n;
    const cure = shortValue === 0n ? 0n : (shortValue * ONE + collateralMark.price - 1n) / collateralMark.price;

    const graceExpiresAt = new Date((loan.marginCalledAt ?? now).getTime() + product.policy.graceSeconds * 1_000);
    const sequence = await this.nextSequence('loan_margin_calls', loan.id);

    await this.sql`
      INSERT INTO bank.loan_margin_calls (loan_id, sequence, ltv_bps, cure_collateral_amount, called_at, grace_expires_at)
      VALUES (${loan.id}, ${sequence}, ${ltv}, ${formatAmount(cure)}::numeric, ${now}, ${graceExpiresAt})
      ON CONFLICT (loan_id, sequence) DO NOTHING
    `;

    await this.sql`
      UPDATE bank.loans
         SET status = 'margin_call', margin_called_at = COALESCE(margin_called_at, ${now}), updated_at = now()
       WHERE id = ${loan.id}
    `;

    // Delivery is recorded separately from the call, and a delivery failure does
    // NOT fail the call. A margin call that exists in the database with a grace
    // clock running is a real margin call even if the notification bounced — and
    // the borrower disputing the liquidation later can be shown exactly that:
    // called at this time, delivery attempted, delivery failed with this error.
    try {
      await this.marginCalls.send({
        loanId: loan.id,
        userId: loan.userId,
        sequence,
        ltvBps: ltv,
        cureCollateralAmount: cure,
        collateralAssetId: loan.collateralAssetId,
        calledAt: now,
        graceExpiresAt,
      });
      await this.sql`
        UPDATE bank.loan_margin_calls SET notified_at = now() WHERE loan_id = ${loan.id} AND sequence = ${sequence}
      `;
    } catch (err) {
      await this.sql`
        UPDATE bank.loan_margin_calls SET notify_error = ${err instanceof Error ? err.message : String(err)}
         WHERE loan_id = ${loan.id} AND sequence = ${sequence}
      `;
    }
  }

  private async clearMarginCalls(loanId: string, now: Date): Promise<void> {
    await this.sql`
      UPDATE bank.loan_margin_calls SET cleared_at = ${now} WHERE loan_id = ${loanId} AND cleared_at IS NULL
    `;
  }

  /**
   * ONE RUNG. Seize, sell and repay atomically; book any shortfall by name.
   */
  private async liquidateTranche(input: {
    loan: LoanRecord;
    product: LoanProductRecord;
    ltv: number;
    graceWaived: boolean;
    collateralToSell: Amount;
    closesPosition: boolean;
    collateralMark: QuotedMark;
    debt: LoanDebt;
    now: Date;
  }): Promise<void> {
    const { loan, product, collateralMark } = input;

    const quoted = await this.venue.quote({
      loanId: loan.id,
      collateralAssetId: loan.collateralAssetId,
      collateralAmount: input.collateralToSell,
      debtAssetId: loan.debtAssetId,
      markPrice: collateralMark.price,
    });

    if (quoted === null || quoted.proceeds <= 0n) {
      // No buyer means no sale. Booking one anyway would post a fictional trade
      // and hand the borrower's collateral to an account that never paid for it.
      throw new BankError(
        `No counterparty for ${formatAmount(input.collateralToSell)} ${loan.collateralAssetId} on loan ${loan.id}`,
        'bank.no_liquidation_counterparty',
      );
    }

    const split = splitProceeds({
      proceeds: quoted.proceeds,
      interestOwed: input.debt.interest,
      principalOwed: input.debt.principal,
      penaltyBps: product.policy.penaltyBps,
      closesPosition: input.closesPosition,
    });

    // A rung left pending (insurance post failed after the sale, or a crash
    // before settle) must be finished, not followed by another sale of the
    // same collateral. The shortfall figure is not on that row yet — it is
    // written with the bad-debt tx id below — so the key is the pending claim.
    const pendingTranche = await this.sql<Array<{ tranche: number }>>`
      SELECT tranche FROM bank.loan_liquidations
       WHERE loan_id = ${loan.id} AND status = 'pending'
       ORDER BY tranche ASC
       LIMIT 1
    `;
    const tranche = pendingTranche[0]
      ? Number(pendingTranche[0].tranche)
      : await this.nextSequence('loan_liquidations', loan.id, 'tranche');

    await withMoneySpan('bank.loan.liquidate', { operation: 'loan-liquidate', loanId: loan.id, tranche }, async (span) => {
      span.setAttribute('intafaced.ltv_bps', input.ltv);
      span.setAttribute('intafaced.grace_waived', input.graceWaived);

      await this.sql`
          UPDATE bank.loans SET status = 'liquidating', updated_at = now() WHERE id = ${loan.id}
        `;

      const ledgerTxId = await this.drivenPost({
        claim: async (tx) => {
          const rows = await tx<Array<{ id: string; ledger_tx_id: string | null }>>`
              INSERT INTO bank.loan_liquidations (
                loan_id, tranche, ltv_bps, mark_price, grace_waived, collateral_sold, proceeds,
                principal_repaid, interest_repaid, penalty, surplus_returned
              ) VALUES (
                ${loan.id}, ${tranche}, ${input.ltv}, ${formatAmount(collateralMark.price)}::numeric,
                ${input.graceWaived}, ${formatAmount(input.collateralToSell)}::numeric,
                ${formatAmount(quoted.proceeds)}::numeric, ${formatAmount(split.principalRepaid)}::numeric,
                ${formatAmount(split.interestRepaid)}::numeric, ${formatAmount(split.penalty)}::numeric,
                ${formatAmount(split.surplusToBorrower)}::numeric
              )
              ON CONFLICT (loan_id, tranche) DO NOTHING
              RETURNING id, ledger_tx_id
            `;
          if (rows.length > 0) return { claimed: true as const, id: rows[0]!.id };
          const existing = await tx<Array<{ id: string; ledger_tx_id: string | null }>>`
              SELECT id, ledger_tx_id FROM bank.loan_liquidations WHERE loan_id = ${loan.id} AND tranche = ${tranche}
            `;
          return { claimed: false as const, id: existing[0]!.id, ledgerTxId: existing[0]!.ledger_tx_id };
        },
        post: () =>
          this.ledger.post(
            recipes.loanLiquidate({
              loanId: loan.id,
              userId: loan.userId,
              tranche,
              collateralAssetId: loan.collateralAssetId,
              collateralSold: input.collateralToSell,
              debtAssetId: loan.debtAssetId,
              proceeds: quoted.proceeds,
              principalRepaid: split.principalRepaid,
              interestRepaid: split.interestRepaid,
              penalty: split.penalty,
              surplusToBorrower: split.surplusToBorrower,
              buyer: quoted.buyer,
              markPrice: collateralMark.price,
            }),
          ),
        table: 'loan_liquidations',
        // Shortfall stays 0 on the claim. It is written in the same statement as
        // the bad-debt tx id, before status becomes settled, so the row never
        // holds a shortfall with a null bad_debt_ledger_tx_id.
        beforeSettle:
          split.shortfall > 0n
            ? async () => {
                await this.coverShortfallTranche(loan, tranche, split.shortfall);
              }
            : undefined,
      });

      void ledgerTxId;

      await this.notifyBankAffiliateAccrue(
        affiliateLegAfterLoanLiquidate({
          loanId: loan.id,
          borrowerId: loan.userId,
          tranche,
          interestRepaid: split.interestRepaid,
          penalty: split.penalty,
          debtAssetId: loan.debtAssetId,
        }),
      );
      await this.notifyBankAffiliatePayout(
        affiliateLegAfterLoanLiquidate({
          loanId: loan.id,
          borrowerId: loan.userId,
          tranche,
          interestRepaid: split.interestRepaid,
          penalty: split.penalty,
          debtAssetId: loan.debtAssetId,
        }),
      );
    });

    const remaining = await this.outstanding(loan.id);
    if (remaining.total <= 0n || input.closesPosition) {
      const held = await this.collateralOf(loan);
      // Surviving collateral on a cleared debt is the borrower's. Not keeping it
      // is the difference between a liquidation and a confiscation.
      if (remaining.total <= 0n && held > 0n) await this.releaseCollateral(loan, held);
      await this.sql`
        UPDATE bank.loans
           SET status = ${remaining.total <= 0n ? 'liquidated' : 'margin_call'}::bank.loan_status,
               closed_at = ${remaining.total <= 0n ? input.now : null},
               updated_at = now()
         WHERE id = ${loan.id}
      `;
      if (remaining.total <= 0n) await this.clearMarginCalls(loan.id, input.now);
    } else {
      // More rungs to come. Back to `margin_call` rather than staying
      // `liquidating`, so the next sweep re-reads the grace clock and the ladder
      // does not run away on one mark.
      await this.sql`UPDATE bank.loans SET status = 'margin_call', updated_at = now() WHERE id = ${loan.id}`;
    }
  }

  /**
   * Post insurance cover for one liquidation tranche's shortfall.
   * Idempotent via ledger key bank.loan.baddebt:${loanId} (one close per loan today).
   */
  private async coverShortfallTranche(loan: LoanRecord, tranche: number, shortfall: Amount): Promise<void> {
    try {
      const posted = await this.ledger.post(recipes.loanBadDebt({ loanId: loan.id, debtAssetId: loan.debtAssetId, shortfall }));
      // A retry after this statement has already run comes back with a later
      // quote. loanBadDebt is keyed by loan id, so the post above returns the
      // original transaction. Writing that quote's shortfall here would replace
      // the figure stored with the first bad-debt tx. Only the still-zero claim
      // takes a shortfall, and it takes it once, in this same statement.
      await this.sql`
        UPDATE bank.loan_liquidations
           SET bad_debt_ledger_tx_id = ${posted.id},
               shortfall = ${formatAmount(shortfall)}::numeric
         WHERE loan_id = ${loan.id} AND tranche = ${tranche}
           AND shortfall = 0
      `;
    } catch (err) {
      if (isInsufficientFunds(err)) {
        throw new BankError(
          `Loan ${loan.id} left ${formatAmount(shortfall)} ${loan.debtAssetId} of bad debt and the ` +
            `insurance fund cannot cover it — the lending reserve is short by that amount`,
          'bank.bad_debt_uncovered',
        );
      }
      throw err;
    }
  }

  private async hasOpenShortfall(loanId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n FROM bank.loan_liquidations
       WHERE loan_id = ${loanId}
         AND status = 'settled'
         AND shortfall > 0
         AND bad_debt_ledger_tx_id IS NULL
    `;
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** Best-effort; never throws. loanRepay / loanLiquidate already posted. */
  private async notifyBankAffiliateAccrue(legs: readonly AffiliateBankFeeLeg[]): Promise<void> {
    await fireAffiliateAccrue(this.affiliateAccrue, legs);
  }

  /** Best-effort payout after accrue; never throws. House fee already posted. */
  private async notifyBankAffiliatePayout(legs: readonly AffiliateBankFeeLeg[]): Promise<void> {
    await fireAffiliatePayout(this.affiliatePayout, legs);
  }

  /** Retry any settled liquidations whose shortfall never made it onto the insurance fund (B-01). */
  private async coverOpenShortfalls(loan: LoanRecord): Promise<void> {
    const rows = await this.sql<Array<{ tranche: number; shortfall: string }>>`
      SELECT tranche, shortfall::text AS shortfall
        FROM bank.loan_liquidations
       WHERE loan_id = ${loan.id}
         AND status = 'settled'
         AND shortfall > 0
         AND bad_debt_ledger_tx_id IS NULL
       ORDER BY tranche ASC
    `;
    for (const row of rows) {
      await this.coverShortfallTranche(loan, Number(row.tranche), parseAmount(row.shortfall));
    }
  }

  // ── Reserve ────────────────────────────────────────────────────────────────

  /**
   * Fund the lending reserve: claim a bank funding row, post the recipe, settle.
   *
   * The row is the independent half of `reconcileReserve` (B-02). Ledger balance
   * alone cannot prove what was funded — a tautology with outstanding. Same
   * `fundingId` re-posts idempotently and returns the original ledger tx.
   */
  async fundReserve(input: { debtAssetId: string; fundingId: string; amount: Amount; from?: AccountRef }): Promise<{ ledgerTxId: string }> {
    if (input.amount <= 0n) {
      throw new BankError('Reserve funding amount must be positive', 'bank.below_minimum');
    }

    const claimed = await this.sql<Array<{ funding_id: string; status: string; ledger_tx_id: string | null; amount: string }>>`
      INSERT INTO bank.loan_reserve_fundings (funding_id, debt_asset_id, amount, status)
      VALUES (${input.fundingId}, ${input.debtAssetId}, ${formatAmount(input.amount)}::numeric, 'pending')
      ON CONFLICT (funding_id) DO NOTHING
      RETURNING funding_id, status, ledger_tx_id, amount::text AS amount
    `;

    if (claimed.length === 0) {
      const existing = await this.sql<Array<{ status: string; ledger_tx_id: string | null; amount: string; debt_asset_id: string }>>`
        SELECT status, ledger_tx_id, amount::text AS amount, debt_asset_id
          FROM bank.loan_reserve_fundings WHERE funding_id = ${input.fundingId}
      `;
      const row = existing[0];
      if (!row) {
        throw new BankError(`Funding ${input.fundingId} disappeared after a conflict`, 'bank.loan_not_found');
      }
      if (row.debt_asset_id !== input.debtAssetId || parseAmount(row.amount) !== input.amount) {
        throw new BankError(`Funding ${input.fundingId} already exists on different terms`, 'bank.loan_principal_mismatch');
      }
      if (row.status === 'settled' && row.ledger_tx_id) {
        return { ledgerTxId: row.ledger_tx_id };
      }
      // Pending retry: re-drive the post below.
    }

    const posted = await this.ledger.post(
      recipes.loanReserveFund({
        fundingId: input.fundingId,
        debtAssetId: input.debtAssetId,
        amount: input.amount,
        ...(input.from ? { from: input.from } : {}),
      }),
    );

    await this.sql`
      UPDATE bank.loan_reserve_fundings
         SET status = 'settled',
             ledger_tx_id = ${posted.id},
             settled_at = now()
       WHERE funding_id = ${input.fundingId}
         AND status = 'pending'
    `;

    return { ledgerTxId: posted.id };
  }

  /**
   * THE RECONCILIATION.
   *
   * Identity: `funded − badDebt ≈ reserveBalance + outstandingPrincipal`.
   * `funded` is the independent sum of settled `loan_reserve_fundings` rows —
   * not reserve + outstanding (a tautology). `drift` is the residual; ops can
   * treat a non-zero drift as a real health signal now that `independent` is true.
   */
  async reconcileReserve(debtAssetId: string): Promise<{
    reserveBalance: Amount;
    outstandingPrincipal: Amount;
    badDebt: Amount;
    funded: Amount;
    drift: Amount;
    /**
     * True when `funded` comes from the bank funding table (independent of the
     * reserve balance). Drift is then a real residual, not a hard-coded zero.
     */
    independent: boolean;
  }> {
    const reserve = await this.ledger.balance(loanReserve(debtAssetId));

    const rows = await this.sql<
      Array<{
        outstanding_principal: string;
        bad_debt: string;
        drawn: string;
        repaid: string;
        recovered: string;
        funded: string;
      }>
    >`
      WITH open_loans AS (
        -- Only DRAWN loans. A pending row's principal never left the reserve;
        -- counting it as outstanding inflates the identity and makes an empty
        -- book look funded by undrawn intentions.
        SELECT id, principal FROM bank.loans
         WHERE debt_asset_id = ${debtAssetId}
           AND drawn_at IS NOT NULL
      )
      SELECT
        COALESCE((SELECT SUM(principal) FROM open_loans), 0) AS drawn,
        COALESCE((SELECT SUM(r.principal_amount) FROM bank.loan_repayments r
                   JOIN open_loans l ON l.id = r.loan_id WHERE r.status = 'settled'), 0) AS repaid,
        COALESCE((SELECT SUM(q.principal_repaid) FROM bank.loan_liquidations q
                   JOIN open_loans l ON l.id = q.loan_id WHERE q.status = 'settled'), 0) AS recovered,
        COALESCE((SELECT SUM(q.shortfall) FROM bank.loan_liquidations q
                   JOIN open_loans l ON l.id = q.loan_id
                  WHERE q.status = 'settled' AND q.bad_debt_ledger_tx_id IS NOT NULL), 0) AS bad_debt,
        COALESCE((SELECT SUM(l.principal) FROM open_loans l), 0) AS outstanding_principal,
        COALESCE((
          SELECT SUM(amount) FROM bank.loan_reserve_fundings
           WHERE debt_asset_id = ${debtAssetId} AND status = 'settled'
        ), 0) AS funded
    `;

    const row = rows[0]!;
    const drawn = parseAmount(row.drawn);
    const repaid = parseAmount(row.repaid);
    const recovered = parseAmount(row.recovered);
    const badDebt = parseAmount(row.bad_debt);
    const outstandingPrincipal = drawn - repaid - recovered - badDebt;
    const outstandingClamped = outstandingPrincipal < 0n ? 0n : outstandingPrincipal;
    const funded = parseAmount(row.funded);
    // Identity: funded − badDebt = reserve + outstanding  →  drift zero when healthy.
    const drift = funded - badDebt - reserve.amount - outstandingClamped;
    const independent = true;

    return {
      reserveBalance: reserve.amount,
      outstandingPrincipal: outstandingClamped,
      badDebt,
      funded,
      drift,
      independent,
    };
  }

  /** Insurance-fund balance — the platform's declared capacity to absorb bad debt. */
  async insuranceCapacity(debtAssetId: string): Promise<Amount> {
    return (await this.ledger.balance(insuranceFund(debtAssetId))).amount;
  }

  /** The borrower's spendable balance in the debt asset. For repayment quotes. */
  async availableOf(loan: LoanRecord): Promise<Amount> {
    return (await this.ledger.balance(userAvailable(loan.userId, loan.debtAssetId))).amount;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Marks that pass the MARKING guards, for a loan's two assets.
   *
   * Refuses rather than defaults. A missing or unusable mark must not become a
   * zero, because a zero collateral mark reads as a borrower with no collateral
   * and the LTV that follows says liquidate.
   */
  private async marksFor(
    collateralAssetId: string,
    debtAssetId: string,
    quoteAssetId: string,
    now: Date,
  ): Promise<Map<string, QuotedMark>> {
    const marks = await this.acceptedMarks([collateralAssetId, debtAssetId], quoteAssetId, now);
    for (const assetId of [collateralAssetId, debtAssetId]) {
      if (!marks.has(assetId)) throw new BankError(`No usable mark for ${assetId} in ${quoteAssetId}`, 'bank.mark_missing');
    }
    return marks;
  }

  private async acceptedMarks(assetIds: readonly string[], quoteAssetId: string, now: Date): Promise<Map<string, QuotedMark>> {
    const raw = await this.options.priceSource.marks(assetIds, quoteAssetId);
    const out = new Map<string, QuotedMark>();
    for (const [assetId, mark] of raw) {
      if (acceptableForMarking(mark, now, this.markPolicy).ok) out.set(assetId, mark);
    }
    return out;
  }

  /**
   * CLAIM ROW → LEDGER POST → RECORD THE TX ID.
   *
   * The shape every money path in svc-bank uses, factored out because getting it
   * subtly different in five places is how one of them ends up double-posting.
   *
   * The claim is inserted first, so a concurrent second runner loses the unique
   * index and returns the first's result. The ledger post is idempotent on a
   * business key, so even a runner that somehow gets past the claim cannot move
   * money twice. Two independent guards, deliberately: the row gives a human a
   * reason, and the ledger key gives the money a guarantee.
   */
  private async drivenPost(input: {
    claim: (tx: Sql) => Promise<{ claimed: boolean; id: string; ledgerTxId?: string | null }>;
    post: () => Promise<{ id: string }>;
    table: string;
    /**
     * Runs after the ledger post and before status becomes `settled`.
     * A liquidation uses this to write shortfall and `bad_debt_ledger_tx_id`
     * together, so the settle update cannot land a settled shortfall with a
     * null bad-debt tx.
     */
    beforeSettle?: () => Promise<void>;
  }): Promise<string> {
    const claim = await transaction(this.sql, async (tx) => input.claim(tx), { isolation: 'read committed', maxAttempts: 5 });

    if (!claim.claimed && claim.ledgerTxId) {
      // ledger_tx_id can be recorded while the row is still pending, when a
      // beforeSettle step has to run before the row may be marked settled.
      // Only a settled row is done.
      const rows = await this.sql.unsafe<Array<{ status: string }>>(`SELECT status FROM bank.${input.table} WHERE id = $1`, [claim.id]);
      if (rows[0]?.status === 'settled') return claim.ledgerTxId;
    }

    // Reached when the row exists but has no tx id: this runner claimed it, or a
    // previous one crashed between the claim and the post. Either way the post is
    // idempotent, so re-driving finds the original transaction or makes it once.
    let posted: { id: string };
    try {
      posted = await input.post();
    } catch (err) {
      await this.sql.unsafe(`UPDATE bank.${input.table} SET status = 'rejected', rejection_code = $1 WHERE id = $2`, [
        err instanceof LedgerError ? err.code : 'bank.post_failed',
        claim.id,
      ]);
      throw err;
    }

    if (input.beforeSettle) {
      await this.sql.unsafe(`UPDATE bank.${input.table} SET ledger_tx_id = $1 WHERE id = $2 AND ledger_tx_id IS NULL`, [posted.id, claim.id]);
      await input.beforeSettle();
    }

    await this.sql.unsafe(`UPDATE bank.${input.table} SET status = 'settled', ledger_tx_id = $1, settled_at = now() WHERE id = $2`, [
      posted.id,
      claim.id,
    ]);

    return posted.id;
  }

  private async repaymentById(eventId: string): Promise<{
    loan_id: string;
    sequence: number;
    interest_amount: string;
    principal_amount: string;
    ledger_tx_id: string | null;
  } | null> {
    const rows = await this.sql<
      Array<{
        loan_id: string;
        sequence: number;
        interest_amount: string;
        principal_amount: string;
        ledger_tx_id: string | null;
      }>
    >`
      SELECT loan_id, sequence, interest_amount, principal_amount, ledger_tx_id
        FROM bank.loan_repayments WHERE id = ${eventId}
    `;
    return rows[0] ?? null;
  }

  private async nextCollateralSequence(loanId: string): Promise<number> {
    return this.nextSequence('loan_collateral_events', loanId);
  }

  private async nextSequence(table: string, loanId: string, column = 'sequence'): Promise<number> {
    const rows = await this.sql.unsafe<Array<{ next: number | null }>>(
      `SELECT MAX("${column}") + 1 AS next FROM bank.${table} WHERE loan_id = $1`,
      [loanId],
    );
    return rows[0]?.next ?? 0;
  }

  private async collateralEvent(loanId: string, sequence: number): Promise<{ amount: string; ledger_tx_id: string | null } | null> {
    const rows = await this.sql<Array<{ amount: string; ledger_tx_id: string | null }>>`
      SELECT amount, ledger_tx_id FROM bank.loan_collateral_events WHERE loan_id = ${loanId} AND sequence = ${sequence}
    `;
    return rows[0] ?? null;
  }

  private async collateralEventById(eventId: string): Promise<{
    loan_id: string;
    sequence: number;
    direction: string;
    amount: string;
    ledger_tx_id: string | null;
  } | null> {
    const rows = await this.sql<
      Array<{ loan_id: string; sequence: number; direction: string; amount: string; ledger_tx_id: string | null }>
    >`
      SELECT loan_id, sequence, direction, amount, ledger_tx_id FROM bank.loan_collateral_events WHERE id = ${eventId}
    `;
    return rows[0] ?? null;
  }

  private async drawRecord(loanId: string): Promise<{ collateralLedgerTxId: string; drawLedgerTxId: string }> {
    const loan = await this.loan(loanId);
    const event = await this.collateralEvent(loanId, 0);
    return { collateralLedgerTxId: event?.ledger_tx_id ?? '', drawLedgerTxId: loan.drawLedgerTxId ?? '' };
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────

function toProduct(row: Record<string, unknown>): LoanProductRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    debtAssetId: String(row.debt_asset_id),
    collateralAssetId: String(row.collateral_asset_id),
    quoteAssetId: String(row.quote_asset_id),
    aprBps: Number(row.apr_bps),
    maxLtvBps: Number(row.max_ltv_bps),
    minPrincipal: parseAmount(String(row.min_principal)),
    policy: {
      marginCallLtvBps: Number(row.margin_call_ltv_bps),
      liquidationLtvBps: Number(row.liquidation_ltv_bps),
      insolvencyLtvBps: Number(row.insolvency_ltv_bps),
      targetLtvBps: Number(row.target_ltv_bps),
      penaltyBps: Number(row.penalty_bps),
      maxTrancheBps: Number(row.max_tranche_bps),
      graceSeconds: Number(row.grace_seconds),
    },
    status: String(row.status),
  };
}

function toLoan(row: Record<string, unknown>): LoanRecord {
  const openingRaw = row.opening_collateral;
  return {
    id: String(row.id),
    productId: String(row.product_id),
    userId: String(row.user_id),
    debtAssetId: String(row.debt_asset_id),
    collateralAssetId: String(row.collateral_asset_id),
    quoteAssetId: String(row.quote_asset_id),
    aprBps: Number(row.apr_bps),
    principal: parseAmount(String(row.principal)),
    openingCollateral: openingRaw === null || openingRaw === undefined ? null : parseAmount(String(openingRaw)),
    status: row.status as LoanRecord['status'],
    drawLedgerTxId: row.draw_ledger_tx_id === null ? null : String(row.draw_ledger_tx_id),
    openedAt: row.opened_at as Date,
    marginCalledAt: row.margin_called_at === null ? null : (row.margin_called_at as Date),
    lastMarkPrice: row.last_mark_price === null || row.last_mark_price === undefined ? null : parseAmount(String(row.last_mark_price)),
    closedAt: row.closed_at === null ? null : (row.closed_at as Date),
  };
}

function isInsufficientFunds(err: unknown): boolean {
  return err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds');
}

export { accrualDay, dailyLoanInterest };
