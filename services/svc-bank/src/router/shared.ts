import { z } from 'zod';
import { TRPCError } from '@intafaced/contracts';
import type { ActionApprovalConsumer } from '../action-approval-consume.js';
import { BankError } from '../errors.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import type { BankServices } from '../bank-service.js';
import type { LoanMissedPaymentPolicy } from '../loans/loan-servicing-preview.js';
import type { StepUpGate } from '../step-up/step-up-gate.js';
import { ALLOCATION_CLASSES, ALLOCATION_TYPES } from '../portfolio/allocation.js';

/**
 * What the svc-bank router files share: output shapes, the destination gate and the options type. The
 * error mapping is errors.ts. Moved verbatim from router.ts.
 */

/** Money crosses the wire as a decimal string. Always. Never a number. */
/** 2-decimal USD figure on the wire. May be negative (a price move). */
export const usd2String = z.string().regex(/^-?\d+\.\d{2}$/);

/** Full-precision signed decimal string (a per-asset value or price move). */
export const signedAmountString = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

export const portfolioSummaryOutput = z.object({
  totalUsd: usd2String.nullable(),
  change24hUsd: usd2String.nullable(),
  cashUsd: usd2String.nullable(),
  cryptoUsd: usd2String.nullable(),
  priced: z.array(
    z.object({
      asset: z.string(),
      amount: z.string(),
      priceUsd: z.string(),
      valueUsd: z.string(),
      change24hUsd: signedAmountString.nullable(),
      pair: z.string().nullable(),
    }),
  ),
  unpriced: z.array(z.object({ asset: z.string(), amount: z.string(), reason: z.enum(['no_market', 'no_price_yet']) })),
  asOf: z.number().int(),
  windowStart: z.number().int().nullable(),
  /** Only when `valueIn` is `btc`. Both fields are null, with a reason, while no BTC price is published. */
  btc: z
    .object({
      total: z.string().nullable(),
      priceUsd: z.string().nullable(),
      reason: z.enum(['no_price_published', 'nothing_priced']).nullable(),
    })
    .optional(),
});

export const destinationViewOutput = z.object({
  destinationId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['crypto', 'bank']),
  ref: z.string(),
  refMasked: z.string(),
  assetId: z.string().nullable(),
  network: z.string().nullable(),
  tag: z.string().nullable(),
  origin: z.enum(['legacy', 'customer']),
  state: z.enum(['pending', 'cooling', 'active', 'blocked', 'archived']),
  addedAt: z.string(),
  coolingOffEndsAt: z.string().nullable(),
  coolingBlocker: z.literal('bank.offramp_cooling_unset').nullable(),
  lookalikeConfirmedAt: z.string().nullable(),
  ownership: z
    .object({
      state: z.enum(['none', 'pending', 'verified', 'expired']),
      verifiedAt: z.string().nullable(),
      validUntil: z.string().nullable(),
      offerExpiresAt: z.string().nullable(),
    })
    .strict(),
  approvedAt: z.string().nullable(),
  approvedBy: z.enum(['link', 'device']).nullable(),
  approvalLinkExpiresAt: z.string().nullable(),
});

export const balanceAccountsOutput = z.object({
  /** Every account the caller can read balances for: `main`, then each named Space. */
  accounts: z.array(z.object({ accountId: z.string(), walletType: z.enum(['main', 'space']), name: z.string().nullable() })),
});

export const balanceBreakdownOutput = z.object({
  assets: z.array(
    z.object({
      assetId: z.string(),
      total: signedAmountString,
      available: signedAmountString,
      locked: z.array(
        z.object({
          kind: z.string(),
          amount: signedAmountString,
          claims: z.array(z.object({ purpose: z.string(), amount: signedAmountString })),
        }),
      ),
    }),
  ),
});

export const balanceEntriesOutput = z.object({
  assetId: z.string(),
  entries: z.array(
    z.object({
      entryId: z.string().nullable(),
      txId: z.string(),
      accountId: z.string(),
      reason: z.string(),
      direction: z.enum(['debit', 'credit']),
      amount: signedAmountString,
      postedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  sumCheck: z.object({ ok: z.literal(true), entriesSum: signedAmountString, balance: signedAmountString, entryCount: z.number().int() }),
});

export const allocationOutput = z.object({
  totalValueUsd: signedAmountString,
  classes: z.array(
    z.object({
      class: z.enum(ALLOCATION_CLASSES),
      valueUsd: signedAmountString,
      share: signedAmountString,
      assets: z.array(z.object({ asset: z.string(), valueUsd: signedAmountString, share: signedAmountString })),
    }),
  ),
  types: z.array(z.object({ type: z.enum(ALLOCATION_TYPES), valueUsd: signedAmountString, share: signedAmountString })),
  unpriced: z.array(z.object({ asset: z.string(), amount: z.string(), reason: z.enum(['no_market', 'no_price_yet']) })),
  asOf: z.number().int(),
});

export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESTINATION GATE — what a caller may be told about somebody else's space.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `transfers.create` and `transfers.schedule` each name TWO spaces and
 * owner-check ONE (see the written reason at those call sites). That is correct
 * for safety and it is the product. It was not correct for disclosure.
 *
 * `space-service.ts` writes its refusals for the person who owns the space:
 * `Space "Holiday fund" is archived`, `Cannot transfer USDT into a EUR space`.
 * Delivered to the owner those sentences are the most useful thing this service
 * says. Delivered to a stranger who guessed a uuid they are an oracle over
 * another user's accounts — existence, the user's own chosen NAME, and the
 * asset — for the price of a transfer that does not even have to succeed.
 *
 * So the message is not the bug and neither is the missing check. The bug is
 * that nothing between them decided whether THIS caller may hear it. This
 * function is that decision, and it has exactly two outcomes:
 *
 *   · the destination is the caller's       → return, and every refusal below
 *                                             reaches them intact, name and all
 *   · it is not, or there is no such space  → `NOT_FOUND`, naming NOTHING, and
 *                                             BYTE-IDENTICAL between the two
 *
 * The second bullet is the whole rule. "Exists but is not yours" and "does not
 * exist" are one answer here — not a lie, because relative to this caller there
 * is no such space in any sense they are entitled to.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: refuse the transfer. Paying a stranger is
 * the product (`bank-service.test.ts` pins that value moves between two
 * different users' spaces), so a destination that is somebody else's, live, and
 * in the right asset proceeds exactly as before. Only the FAILURES stop
 * describing it.
 *
 * The three conditions checked here are the three `space-service.ts` refuses a
 * credit on, and they are re-checked inside `TransferService` where they are
 * ENFORCED. This is not a second enforcement point; it is a disclosure gate
 * that happens to have to know the same three facts.
 */
export const NO_SUCH_DESTINATION = 'No such space';

/** One construction site, so the two paths cannot drift apart by a byte. */
export function noSuchDestination(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: NO_SUCH_DESTINATION });
}

export async function gateDestination(
  bank: BankServices,
  callerUserId: string | undefined,
  from: SpaceRecord,
  toSpaceId: string,
): Promise<{ mayDescribe: boolean }> {
  // One SELECT, and the same one, whether the row is there or not — `find`
  // rather than `get` for that reason. A lookup that throws for "absent" makes
  // the absent path do measurably different work from the present one, and the
  // ADR's done bar names timing as well as status.
  const to = await bank.spaces.find(toSpaceId);

  if (to !== null && to.userId === callerUserId) return { mayDescribe: true };

  // From here the caller is entitled to nothing about this space, so every
  // branch produces the same object. Ordering is irrelevant — they are equal.
  if (to === null) throw noSuchDestination();
  if (to.archivedAt) throw noSuchDestination();
  if (to.assetId !== from.assetId) throw noSuchDestination();

  // Otherwise: somebody else's live space in the right asset. Cross-user
  // transfer is the product; it proceeds, and a failure after this point comes
  // from the caller's OWN side — their funds, their lock — and is theirs to
  // read.
  return { mayDescribe: false };
}

/**
 * The backstop, for a refusal the gate above did not anticipate.
 *
 * `TransferService` resolves the destination again and could grow a new
 * destination-side precondition without this file noticing. These two codes can
 * only be about the destination once `from` has been fetched and its asset is
 * known, so they are flattened rather than trusted. `bank.space_archived` is
 * NOT in the list on purpose: the gate already covered the destination case,
 * which leaves the caller's OWN archived space as the remaining source, and
 * that message belongs to them.
 */
export function hideDestinationDetail(err: unknown): unknown {
  if (err instanceof BankError && (err.code === 'bank.space_not_found' || err.code === 'bank.asset_mismatch')) {
    return noSuchDestination();
  }
  // A recipient who is frozen, closed or unknown reads exactly like a space that
  // does not exist: relative to this caller there is nothing to learn about them.
  if (err instanceof BankError && err.code === 'bank.recipient_cannot_receive') {
    return noSuchDestination();
  }
  return err;
}

export const spaceOutput = z.object({
  id: z.string(),
  assetId: z.string(),
  kind: z.enum(['primary', 'named']),
  name: z.string(),
  goalTarget: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  /** Read from the ledger at request time. Not stored, not cached. */
  balance: amountString,
  /** The ledger account this space is a view of — so a client can verify us. */
  ledgerAccount: z.object({ ownerType: z.string(), ownerId: z.string(), assetId: z.string(), kind: z.string() }),
});

/**
 * Optional kill switches for operator jobs. Production passes live env values
 * from `index.ts`; tests inject without loading `env` (which needs full service env).
 *
 * Every flag that gates an HTTP `/internal/jobs/*` endpoint MUST also gate the
 * matching `ops.*` mutation. A tRPC-only back door past an emergency stop is
 * the residual #1271 closed for transfers and that this options bag closes for
 * earn accrual, loan accrual, and the risk sweep.
 */
export type BankRouterOptions = {
  /** When false, `ops.runDueTransfers` refuses with `bank.transfers_disabled`. Default true. */
  scheduledTransfersEnabled?: boolean;
  /** When false, `ops.accrueInterest` refuses with `bank.interest_accrual_disabled`. Default true. */
  interestAccrualEnabled?: boolean;
  /** When false, `ops.accrueLoanInterest` refuses with `bank.loan_accrual_disabled`. Default true. */
  loanAccrualEnabled?: boolean;
  /** When false, `ops.runRiskSweep` refuses with `bank.loan_risk_sweep_disabled`. Default true. */
  loanRiskSweepEnabled?: boolean;
  /** When false, `ops.runAutoInvest` refuses with `bank.auto_invest_disabled`. Default true. */
  autoInvestEnabled?: boolean;
  /** True when trade.convert ConvertPort is wired at boot. */
  autoInvestConvertWired?: boolean;
  /**
   * Identity HMAC consume for treasury ops.* mutates. Blank IDENTITY_URL at boot
   * injects unwired — tests pass stubApprovalConsumer(approverId).
   */
  approvals?: ActionApprovalConsumer;
  /**
   * Money-out step-up (BANK_STEP_UP_MONEY_OUT). Omitted or `off` leaves the money-out doors as they
   * were. Card number, CVV and PIN reveal/set are the exception: they refuse
   * `bank.step_up_unavailable` until the mode is `required`. When `required`, sends to other users,
   * business payments and membership, card unfreeze/issue and standing orders to other people need
   * `stepUpApprovalId` (a same-person identity approval).
   */
  stepUp?: StepUpGate;
  /** BK-loan-09: owner-published missed-payment policy. Omitted: `loans.missedPaymentPolicy` reads `not_set`. */
  loanMissedPaymentPolicy?: LoanMissedPaymentPolicy | null;
};

/** Optional on the wire so a missing approval is `bank.step_up_required`, not a Zod error. */
export const stepUpApprovalField = z.string().min(1).max(128).optional();

export function refuseCardSecretWithoutStepUp(): never {
  throw new BankError(
    'Showing or setting card secrets needs step-up, and step-up is not switched on in this deployment.',
    'bank.step_up_unavailable',
  );
}

export const actionApprovalFields = {
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
};
