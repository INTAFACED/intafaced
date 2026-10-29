import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  FRAUD_BLOCK_STANCES,
  FRAUD_PREVIEW_ACTIONS,
  FRAUD_RISK_BANDS,
  FRAUD_SIGNALS,
  fraudPreview,
  refuseFraudPreviewAction,
} from '../cards/fraud-preview.js';
import { poolTotalsProcedure } from '../ops/pool-totals.js';
import { loanBookProcedure } from '../ops/loan-book.js';
import { assetPausesProcedure, setAssetPauseProcedure } from '../ops/asset-pause.js';
import { cardProgrammeProcedure, setCardStatusProcedure } from '../ops/card-programme.js';
import { decideLimitRequestProcedure, limitRequestQueueProcedure } from '../transfers/limit-requests.js';
import { createLoanProductProcedure } from '../ops/loan-products.js';
import { createEarnPoolProcedure, setEarnPoolRateProcedure } from '../ops/earn-pools.js';
import { publishTransferTermsProcedure } from '../transfers/transfer-terms.js';
import { DestinationFraudList, destinationFraudListProcedure, setDestinationFraudListingProcedure } from '../ramps/fraud-list.js';
import { rampHealthProcedure } from '../ops/ramp-health.js';
import { transferHealthProcedure } from '../ops/transfer-health.js';
import { failedTransfersProcedure } from '../ops/failed-transfers.js';
import { customerBalanceEntriesProcedure, customerBalancesProcedure } from '../ops/customer-balances.js';
import { transferDetailProcedure } from '../ops/transfer-detail.js';
import { authorizationGetProcedure } from '../ops/authorization-detail.js';
import { businessApprovalsProcedure } from '../ops/business-approvals.js';
import { ADJUST_LOAN_INTEREST_ACTION, correctionApprovalFields } from '../loans/loan-adjustments.js';
import { amountString, actionApprovalFields, signedAmountString } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createOpsRouter(c: BankRouterContext) {
  const {
    bank,
    scheduledTransfersEnabled,
    interestAccrualEnabled,
    loanAccrualEnabled,
    loanRiskSweepEnabled,
    autoInvestEnabled,
    limitRequests,
    consumeOpsApproval,
    consumeOpsApprovalPair,
    jobProcedure,
  } = c;
  /**
   * Operator surface. Job twins of POST /internal/jobs/* are HMAC as svc-bank
   * (`jobProcedure`). Treasury-session mutations that move value (fund, seize,
   * card, ramp) stay `admin:treasury` — MFA via INTERACTIVE_ONLY plus identity
   * HMAC consume. Typed-in `confirmOperatorId` is not authority. HMAC jobs are
   * not this door. Bank maker-checker is not this door.
   */
  return router({
    /**
     * BK-cops-09 fraud preview (/bank-ops/cards/fraud). TEST rows only, labelled
     * and blurred; no authorisation carries a score until an engine exists.
     */
    fraudPreview: scopedProcedure('admin:treasury')
      .output(
        z.object({
          label: z.literal('Preview · sample data'),
          engine: z.string(),
          preview: z.literal(true),
          blurred: z.literal(true),
          stances: z.array(z.enum(FRAUD_BLOCK_STANCES)),
          automaticBlocking: z.literal('unavailable'),
          rows: z.array(
            z.object({
              testAuthorisationRef: z.string().startsWith('TEST-'),
              test: z.literal(true),
              band: z.enum(FRAUD_RISK_BANDS),
              signals: z.array(z.enum(FRAUD_SIGNALS)),
            }),
          ),
        }),
      )
      .query(() => {
        const view = fraudPreview();
        return { ...view, stances: [...view.stances], rows: view.rows.map((r) => ({ ...r, signals: [...r.signals] })) };
      }),
    /** Every engine action on the fraud preview returns the typed Preview refusal and changes nothing. */
    fraudPreviewAction: scopedProcedure('admin:treasury')
      .input(z.object({ action: z.enum(FRAUD_PREVIEW_ACTIONS) }))
      .output(
        z.object({ kind: z.literal('preview'), engine: z.string(), action: z.enum(FRAUD_PREVIEW_ACTIONS), changed: z.literal(false) }),
      )
      .mutation(({ input }) => refuseFraudPreviewAction(input.action)),
    runDueTransfers: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          schedulesConsidered: z.number().int(),
          settled: z.number().int(),
          rejected: z.number().int(),
          alreadyFired: z.number().int(),
          /** Schedules looked at only because a claim was left behind. An operator wants zero. */
          strandedSwept: z.number().int(),
          /** Schedules that threw mid-drive; occurrence not consumed; next pass retries. */
          failures: z.array(
            z.object({
              scheduleId: z.string(),
              reason: z.string(),
              code: z.string().optional(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/run-due-transfers: the flag is the
          // emergency stop for a mis-computed occurrence index. tRPC must not
          // be a back door past it.
          if (!scheduledTransfersEnabled) {
            throw new BankError('scheduled transfers are disabled', 'bank.transfers_disabled');
          }
          return bank.transfers.runDueTransfers({ limit: input.limit });
        }),
      ),

    /**
     * Fire due auto-invest rules (threshold sweeps always; DCA when convert is wired).
     * Kill-switch parity with HTTP `POST /internal/jobs/run-auto-invest`.
     */
    runAutoInvest: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          considered: z.number().int(),
          settled: z.number().int(),
          skipped: z.number().int(),
          rejected: z.number().int(),
          failures: z.array(z.object({ ruleId: z.string(), code: z.string() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          if (!autoInvestEnabled) {
            throw new BankError('auto-invest is disabled', 'bank.auto_invest_disabled');
          }
          return bank.autoInvest.runDue({ limit: input.limit });
        }),
      ),

    /**
     * Start the next term of every ended fixed-term saving with auto-renew on (BK-earn-03). Moves no money; keyed per
     * (saving, term), so a second run renews nothing twice. tRPC only: the scheduler signs as svc-bank.
     */
    renewEarnTerms: jobProcedure
      .input(
        z.object({
          limit: z.number().int().min(1).max(1_000).optional(),
          poolId: z.string().guid().optional(),
          at: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(
        z.object({
          renewed: z.array(z.object({ positionId: z.string(), terms: z.array(z.number().int()), maturesAt: z.string() })),
          skipped: z.array(z.object({ positionId: z.string(), code: z.string() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const report = await bank.earn.renewDue({
            limit: input.limit,
            ...(input.poolId ? { poolId: input.poolId } : {}),
            ...(input.at ? { at: new Date(input.at) } : {}),
          });
          return {
            renewed: report.renewed.map((r) => ({ positionId: r.positionId, terms: r.terms, maturesAt: r.maturesAt.toISOString() })),
            skipped: report.skipped,
          };
        }),
      ),

    accrueInterest: jobProcedure
      .input(z.object({ poolId: z.string().guid().optional(), at: z.string().datetime({ offset: true }).optional() }))
      .output(
        z.object({
          results: z.array(
            z.object({
              poolId: z.string(),
              date: z.string(),
              paid: amountString,
              recipients: z.number().int(),
              alreadyAccrued: z.boolean(),
            }),
          ),
          /** Pools that threw (e.g. underfunded); day not consumed for those pools. */
          failures: z.array(
            z.object({
              poolId: z.string(),
              reason: z.string(),
              code: z.string().optional(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/accrue-interest.
          if (!interestAccrualEnabled) {
            throw new BankError('interest accrual is disabled', 'bank.interest_accrual_disabled');
          }
          const at = input.at ? new Date(input.at) : new Date();
          // Single-pool path stays loud: operator targeted that pool, so throw.
          if (input.poolId) {
            const r = await bank.earn.accrue({ poolId: input.poolId, at });
            return {
              results: [
                {
                  poolId: r.poolId,
                  date: r.date,
                  paid: formatAmount(r.paid),
                  recipients: r.recipients,
                  alreadyAccrued: r.alreadyAccrued,
                },
              ],
              failures: [],
            };
          }
          const report = await bank.earn.accrueAll(at);
          return {
            results: report.results.map((r) => ({
              poolId: r.poolId,
              date: r.date,
              paid: formatAmount(r.paid),
              recipients: r.recipients,
              alreadyAccrued: r.alreadyAccrued,
            })),
            failures: report.failures,
          };
        }),
      ),

    fundPool: scopedProcedure('admin:treasury')
      .input(
        z.object({
          poolId: z.string().guid(),
          fundingId: z.string().min(4).max(64),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.fund_pool', {
            poolId: input.poolId,
            fundingId: input.fundingId,
            amount: input.amount,
          });
          const posted = await bank.earn.fundPool({
            poolId: input.poolId,
            fundingId: input.fundingId,
            amount: parseAmount(input.amount),
          });
          return { ...posted, confirmOperatorId };
        }),
      ),

    // ── Loans (§8.1) ─────────────────────────────────────────────────────────
    //
    // THE RISK SWEEP AND THE LADDER ARE OPERATOR SURFACE, NOT USER SURFACE.
    //
    // A user able to trigger a mark is a user able to choose when their own — or
    // a rival's — collateral is priced, which is precisely what the staleness
    // window and the deviation breaker exist to take out of anyone's hands. Same
    // reasoning as the standing-order runner above: safe to run twice is not a
    // reason to let an untrusted caller choose when.

    fundLoanReserve: scopedProcedure('admin:treasury')
      .input(
        z.object({
          debtAssetId: z.string().min(1).max(16),
          fundingId: z.string().min(4).max(64),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.fund_loan_reserve', {
            debtAssetId: input.debtAssetId,
            fundingId: input.fundingId,
            amount: input.amount,
          });
          const posted = await bank.loans.fundReserve({
            debtAssetId: input.debtAssetId,
            fundingId: input.fundingId,
            amount: parseAmount(input.amount),
          });
          return { ...posted, confirmOperatorId };
        }),
      ),

    /**
     * LOAN-05 interest correction, four-eyes: one founder proposes `bank.adjust_loan_interest` over these exact fields
     * at identity, the other approves, and this door consumes that approval and writes one new correction row. It moves
     * no value and edits no past day. A retry with the same id and terms returns the first row without consuming again;
     * a correction that would be refused is refused before the approval is spent.
     */
    adjustLoanInterest: scopedProcedure('admin:treasury')
      .input(
        z.object({
          loanId: z.string().guid(),
          adjustmentId: z.string().guid(),
          amount: signedAmountString,
          reason: z.string().min(3).max(500),
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          adjustmentId: z.string(),
          loanId: z.string(),
          amount: z.string(),
          reason: z.string(),
          proposedBy: z.string(),
          approvedBy: z.string(),
          createdAt: z.string(),
          replay: z.boolean(),
          interestOwed: amountString,
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const terms = { adjustmentId: input.adjustmentId, loanId: input.loanId, amount: input.amount, reason: input.reason };
          const prior = await bank.loans.interestAdjustment(input.adjustmentId);
          let written;
          if (prior) {
            bank.loans.assertSameCorrection(prior, terms);
            written = { adjustment: prior, replay: true };
          } else {
            await bank.loans.checkCorrection(terms);
            const pair = await consumeOpsApprovalPair(input, ADJUST_LOAN_INTEREST_ACTION, correctionApprovalFields(terms));
            written = await bank.loans.correctInterest(terms, {
              proposedBy: pair.requesterId,
              approvedBy: pair.approverId,
              approvalId: pair.approvalId,
            });
          }
          const debt = await bank.loans.outstanding(input.loanId);
          const a = written.adjustment;
          return {
            adjustmentId: a.id,
            loanId: a.loanId,
            amount: formatAmount(a.amount),
            reason: a.reason,
            proposedBy: a.proposedBy,
            approvedBy: a.approvedBy,
            createdAt: a.createdAt.toISOString(),
            replay: written.replay,
            interestOwed: formatAmount(debt.interest),
          };
        }),
      ),

    accrueLoanInterest: jobProcedure
      .input(
        z.object({
          loanId: z.string().guid().optional(),
          at: z.string().datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(10_000).optional(),
        }),
      )
      .output(
        z.object({
          results: z.array(z.object({ loanId: z.string(), charged: amountString, days: z.number().int() })),
          failures: z.array(z.object({ loanId: z.string(), reason: z.string(), code: z.string().optional() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/accrue-loan-interest.
          if (!loanAccrualEnabled) {
            throw new BankError('loan interest accrual is disabled', 'bank.loan_accrual_disabled');
          }
          const at = input.at ? new Date(input.at) : new Date();
          if (input.loanId) {
            const one = await bank.loans.accrue({ loanId: input.loanId, until: at });
            return {
              results: [{ loanId: one.loanId, charged: formatAmount(one.charged), days: one.days.length }],
              failures: [],
            };
          }
          const all = await bank.loans.accrueAll(at, input.limit);
          return {
            results: all.results.map((r) => ({ loanId: r.loanId, charged: formatAmount(r.charged), days: r.days })),
            failures: all.failures,
          };
        }),
      ),

    runRiskSweep: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          marked: z.number().int(),
          called: z.number().int(),
          liquidated: z.number().int(),
          cleared: z.number().int(),
          // Loans the sweep declined to act on — an unusable mark, no
          // counterparty, a reserve that cannot cover. Surfaced rather than
          // swallowed: a silent refusal is a position nobody is watching.
          refused: z.array(z.object({ loanId: z.string(), reason: z.string() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/run-risk-sweep. Defaults off in
          // production; a treasury caller must not liquidate past that stop.
          if (!loanRiskSweepEnabled) {
            throw new BankError('loan risk sweep is disabled', 'bank.loan_risk_sweep_disabled');
          }
          return bank.loans.runRiskSweep({ limit: input.limit });
        }),
      ),

    /**
     * Seize one underwater loan through ledger-client. Marks first — a missing
     * mark refuses `bank.mark_missing` before any post. Same kill as the sweep.
     */
    seizeLoan: scopedProcedure('admin:treasury')
      .input(z.object({ loanId: z.string().guid(), ...actionApprovalFields }))
      .output(
        z.object({
          ledgerTxId: z.string(),
          collateralSold: amountString,
          proceeds: amountString,
          principalRepaid: amountString,
          interestRepaid: amountString,
          closed: z.boolean(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.seize_loan', { loanId: input.loanId });
          if (!loanRiskSweepEnabled) {
            throw new BankError('loan risk sweep is disabled', 'bank.loan_risk_sweep_disabled');
          }
          const result = await bank.loans.seize({ loanId: input.loanId });
          return {
            ledgerTxId: result.ledgerTxId,
            collateralSold: formatAmount(result.collateralSold),
            proceeds: formatAmount(result.proceeds),
            principalRepaid: formatAmount(result.principalRepaid),
            interestRepaid: formatAmount(result.interestRepaid),
            closed: result.closed,
            confirmOperatorId,
          };
        }),
      ),

    /** Re-drive loans stuck between the collateral lock and the draw. */
    resumePendingLoans: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(1_000).optional() }))
      .output(z.array(z.object({ loanId: z.string(), outcome: z.string(), reason: z.string().optional() })))
      .mutation(async ({ input }) => guard(async () => bank.loans.resumePending(input.limit))),

    /** Give up on a pending loan and give the borrower their collateral back. */
    abandonPendingLoan: scopedProcedure('admin:treasury')
      .input(z.object({ loanId: z.string().guid(), ...actionApprovalFields }))
      .output(
        z.object({
          released: amountString,
          ledgerTxId: z.string().nullable(),
          /** True when the draw had in fact booked: the loan was completed to active and no collateral moved. */
          adopted: z.boolean(),
          drawLedgerTxId: z.string().nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.abandon_pending_loan', { loanId: input.loanId });
          const result = await bank.loans.abandonPending(input.loanId);
          return {
            released: formatAmount(result.released),
            ledgerTxId: result.ledgerTxId,
            adopted: result.adopted,
            drawLedgerTxId: result.drawLedgerTxId,
            confirmOperatorId,
          };
        }),
      ),

    /**
     * Re-drive earn deposits stuck between the ledger post and activate.
     * Same recovery shape as `resumePendingLoans`; key is bank.earn.deposit:<id>.
     */
    resumePendingEarn: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(1_000).optional() }))
      .output(z.array(z.object({ positionId: z.string(), outcome: z.string(), reason: z.string().optional() })))
      .mutation(async ({ input }) => guard(async () => bank.earn.resumePending(input.limit))),

    // ── Cards (§8.1, ledger half) ────────────────────────────────────────────
    //
    // THE ISSUER'S SIDE OF THE CONVERSATION, NOT THE USER'S.
    //
    // On a live rail these three are a signed webhook from the issuer, arriving
    // on a deadline the card network sets. There is no live rail — that is
    // `socket.live-issuer`, a sponsor bank and an issuing BIN — so today they are
    // operator surface, and they must NEVER become user surface: a user who can
    // call `cardAuthorize` approves their own purchase, and a user who can call
    // `cardCapture` chooses when their own money leaves the book.
    //
    // The simulator is what makes them exercisable at all, and it says so on
    // every card it issues (`simulated: true`).

    cardAuthorize: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().guid(),
          authorizationRef: z.string().min(4).max(128),
          /**
           * THE MERCHANT'S NUMBER, in the card's SETTLEMENT asset.
           *
           * The same asset the card draws on unless the card was issued with a
           * settlement asset of its own — in which case this is converted at a
           * rate quoted now and frozen, and refuses `bank.mark_missing` if no
           * rate can be got rather than guessing one.
           */
          amount: amountString,
          merchantCategory: z.string().min(1).max(64).optional(),
          channel: z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']).optional(),
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          authorizationId: z.string(),
          decision: z.enum(['approved', 'declined']),
          declineCode: z.string().nullable(),
          /** WHAT WAS HELD, in the funding asset. The converted figure on a converted card. */
          amount: amountString,
          /** The frozen quote, or null because this card converts nothing. */
          conversion: z
            .object({
              settlementAssetId: z.string(),
              settlementAmount: amountString,
              rate: amountString,
              rateQuality: z.string(),
              rateAsOf: z.string(),
            })
            .nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_authorize', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: input.amount,
          });
          const authorization = await bank.cards.authorize({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: parseAmount(input.amount),
            ...(input.merchantCategory === undefined ? {} : { merchantCategory: input.merchantCategory }),
            ...(input.channel === undefined ? {} : { channel: input.channel }),
          });
          return {
            authorizationId: authorization.id,
            decision: authorization.decision,
            declineCode: authorization.declineCode,
            amount: formatAmount(authorization.amount),
            conversion: authorization.conversion
              ? {
                  settlementAssetId: authorization.conversion.settlementAssetId,
                  settlementAmount: formatAmount(authorization.conversion.settlementAmount),
                  rate: formatAmount(authorization.conversion.rate),
                  rateQuality: authorization.conversion.quality,
                  rateAsOf: authorization.conversion.rateAsOf.toISOString(),
                }
              : null,
            confirmOperatorId,
          };
        }),
      ),

    cardCapture: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().guid(),
          authorizationRef: z.string().min(4).max(128),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          /** WHAT LEFT THE BOOK, in the funding asset. */
          captured: amountString,
          returned: amountString,
          captureLedgerTxId: z.string(),
          reversalLedgerTxId: z.string().nullable(),
          /**
           * What the merchant cleared and the FROZEN rate it converted at — the
           * rate the authorisation was decided on, re-read and never re-quoted.
           * Null on a card that converts nothing.
           */
          settlement: z.object({ assetId: z.string(), amount: amountString, rate: amountString }).nullable(),
          // Surfaced rather than swallowed. A reward the rewards pot could not
          // pay is a fact an operator needs on the day it happens — the same
          // reasoning as `runRiskSweep.refused`.
          cashback: z.object({
            status: z.enum(['none', 'paid', 'refused']),
            amount: amountString,
            reason: z.string().optional(),
          }),
          /**
           * Spare-change sweep. Capture still stands when this is skipped or
           * refused — same reporting rule as cashback.
           */
          roundUp: z.object({
            status: z.enum(['none', 'skipped', 'settled', 'refused']),
            amount: amountString,
            reason: z.string().optional(),
            positionId: z.string().optional(),
            /** A round-up into one of the person's own spaces: that space and the transfer that moved it. */
            spaceId: z.string().optional(),
            ledgerTxId: z.string().optional(),
          }),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_capture', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: input.amount,
          });
          const result = await bank.cards.capture({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: parseAmount(input.amount),
          });
          return {
            captured: formatAmount(result.captured),
            returned: formatAmount(result.returned),
            captureLedgerTxId: result.captureLedgerTxId,
            reversalLedgerTxId: result.reversalLedgerTxId,
            settlement: result.settlement
              ? {
                  assetId: result.settlement.assetId,
                  amount: formatAmount(result.settlement.amount),
                  rate: formatAmount(result.settlement.rate),
                }
              : null,
            cashback: {
              status: result.cashback.status,
              amount: formatAmount(result.cashback.amount),
              ...(result.cashback.status === 'refused' ? { reason: result.cashback.reason } : {}),
            },
            roundUp: {
              status: result.roundUp.status,
              amount: formatAmount(result.roundUp.amount),
              ...(result.roundUp.status === 'skipped' || result.roundUp.status === 'refused' ? { reason: result.roundUp.reason } : {}),
              ...(result.roundUp.status === 'settled'
                ? 'positionId' in result.roundUp
                  ? { positionId: result.roundUp.positionId }
                  : { spaceId: result.roundUp.spaceId, ledgerTxId: result.roundUp.ledgerTxId }
                : {}),
            },
            confirmOperatorId,
          };
        }),
      ),

    /** The authorisation expired or was voided. The whole hold goes back. */
    cardReverse: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().guid(),
          authorizationRef: z.string().min(4).max(128),
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ returned: amountString, ledgerTxId: z.string(), confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_reverse', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
          });
          const result = await bank.cards.reverse({ cardId: input.cardId, authorizationRef: input.authorizationRef });
          return { returned: formatAmount(result.returned), ledgerTxId: result.ledgerTxId, confirmOperatorId };
        }),
      ),

    /**
     * Re-drive card settlements that were claimed and never reached the ledger,
     * and report what is still held against the authorisation.
     *
     * The card equivalent of `resumePendingLoans`, and it exists for the same
     * reason: one failed post must not leave a user's hold unreachable. Takes no
     * amount — each row is re-driven for the amount it was claimed with, because
     * a recovery that can restate what moved is not a recovery.
     */
    cardResumeSettlement: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().guid(),
          authorizationRef: z.string().min(4).max(128),
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          authorizationId: z.string(),
          resumed: z.array(
            z.object({
              sequence: z.number().int(),
              kind: z.enum(['capture', 'reversal']),
              amount: amountString,
              outcome: z.enum(['settled', 'failed']),
              ledgerTxId: z.string().optional(),
              reason: z.string().optional(),
            }),
          ),
          // Read from the ledger, not added up from our own rows. Zero is the
          // invariant an operator is actually checking for after a recovery.
          held: amountString,
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_resume_settlement', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
          });
          const result = await bank.cards.resumeSettlements({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
          });
          return {
            authorizationId: result.authorizationId,
            resumed: result.resumed.map((row) => ({
              sequence: row.sequence,
              kind: row.kind,
              amount: formatAmount(row.amount),
              outcome: row.outcome,
              ...(row.ledgerTxId === undefined ? {} : { ledgerTxId: row.ledgerTxId }),
              ...(row.reason === undefined ? {} : { reason: row.reason }),
            })),
            held: formatAmount(result.held),
            confirmOperatorId,
          };
        }),
      ),

    /**
     * Move bank revenue into the pot cashback is paid from.
     *
     * The named source, in one call. Cashback is a share of fees the platform
     * really charged; a pot funded from anywhere else would make the advertised
     * rate a promise against revenue that has not happened.
     */
    fundCashbackPot: scopedProcedure('admin:treasury')
      .input(
        z.object({
          windowId: z.string().min(4).max(64),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), capacity: amountString, confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.fund_cashback_pot', {
            windowId: input.windowId,
            assetId: input.assetId,
            amount: input.amount,
          });
          const posted = await bank.cards.fundCashbackPot({
            windowId: input.windowId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
          });
          return {
            ledgerTxId: posted.ledgerTxId,
            capacity: formatAmount(await bank.cards.cashbackCapacity(input.assetId)),
            confirmOperatorId,
          };
        }),
      ),

    /**
     * The reserve identity, as a query rather than an investigation:
     * `balance(loanReserve) + Σ outstanding principal` against what was funded.
     */
    reconcileLoanReserve: scopedProcedure('admin:treasury')
      .input(z.object({ debtAssetId: z.string().min(1).max(16) }))
      .output(
        z.object({
          reserveBalance: amountString,
          outstandingPrincipal: amountString,
          badDebt: amountString,
          funded: amountString,
          drift: amountString,
          /** False until funded is journal-independent; do not treat drift 0 as green. */
          independent: z.boolean(),
          insuranceCapacity: amountString,
        }),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const r = await bank.loans.reconcileReserve(input.debtAssetId);
          return {
            reserveBalance: formatAmount(r.reserveBalance),
            outstandingPrincipal: formatAmount(r.outstandingPrincipal),
            badDebt: formatAmount(r.badDebt),
            funded: formatAmount(r.funded),
            drift: formatAmount(r.drift),
            independent: r.independent,
            insuranceCapacity: formatAmount(await bank.loans.insuranceCapacity(input.debtAssetId)),
          };
        }),
      ),

    /**
     * Operator on-ramp credit for the CRYPTO ledger half.
     *
     * Not user-callable: a user who credits their own balance does not need a
     * ramp. Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post.
     */
    creditOnramp: scopedProcedure('admin:treasury')
      .input(
        z.object({
          userId: z.string().min(1),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']).default('crypto'),
          railRef: z.string().min(1).max(256),
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          id: z.string(),
          userId: z.string(),
          assetId: z.string(),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']),
          rail: z.string(),
          railRef: z.string(),
          simulated: z.boolean(),
          status: z.string(),
          ledgerTxId: z.string().nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.credit_onramp', {
            userId: input.userId,
            assetId: input.assetId,
            amount: input.amount,
            kind: input.kind,
            railRef: input.railRef,
          });
          const row = await bank.ramps.creditOnramp({
            userId: input.userId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
            kind: input.kind,
            railRef: input.railRef,
            creditedBy: ctx.principal.userId,
          });
          return {
            id: row.id,
            userId: row.userId,
            assetId: row.assetId,
            amount: formatAmount(row.amount),
            kind: row.kind,
            rail: row.rail,
            railRef: row.railRef,
            simulated: row.simulated,
            status: row.status,
            ledgerTxId: row.ledgerTxId,
            confirmOperatorId,
          };
        }),
      ),

    poolTotals: poolTotalsProcedure(() => bank.earn.poolTotals(), guard),
    loanBook: loanBookProcedure(() => bank.loans.loanBook(), guard),
    assetPauses: assetPausesProcedure(() => bank.assetPauses, guard),
    setAssetPause: setAssetPauseProcedure(() => bank.assetPauses, consumeOpsApproval, guard),
    limitRequests: limitRequestQueueProcedure(limitRequests, guard),
    decideLimitRequest: decideLimitRequestProcedure(limitRequests, guard),
    createLoanProduct: createLoanProductProcedure(bank, consumeOpsApproval, guard),
    createEarnPool: createEarnPoolProcedure(bank, consumeOpsApproval, guard),
    setEarnPoolRate: setEarnPoolRateProcedure(bank, consumeOpsApproval, guard),
    publishTransferTerms: publishTransferTermsProcedure(() => bank.transferOps.sql, consumeOpsApproval, guard),
    /** W-withdraw-03: the destination fraud list. Read on the desk; a listing or delisting needs compliance and a second person. */
    destinationFraudList: destinationFraudListProcedure(() => new DestinationFraudList(bank.transferOps.sql), guard),
    setDestinationFraudListing: setDestinationFraudListingProcedure(
      () => new DestinationFraudList(bank.transferOps.sql),
      consumeOpsApprovalPair,
      guard,
    ),
    cardProgramme: cardProgrammeProcedure(bank, guard),
    setCardStatus: setCardStatusProcedure(bank, consumeOpsApproval, guard),
    rampHealth: rampHealthProcedure(bank, guard),
    transferHealth: transferHealthProcedure(bank, guard),
    failedTransfers: failedTransfersProcedure(bank, guard),
    transferDetail: transferDetailProcedure(bank, guard),
    /** BK-cops-01: one card authorisation for a compliance operator. Read-only. */
    authorizationGet: authorizationGetProcedure(bank, guard),
    customerBalances: customerBalancesProcedure(bank, guard),
    customerBalanceEntries: customerBalanceEntriesProcedure(bank, guard),
    businessApprovals: businessApprovalsProcedure(bank, guard),
  });
}
