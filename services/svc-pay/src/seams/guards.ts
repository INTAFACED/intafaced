import type { Sql } from 'postgres';
import { TRPCError } from '@intafaced/contracts';
import type { Amount } from '@intafaced/ledger-client';

/**
 * GUARD SEAMS (W0).
 *
 * Named hooks called on every path where value is admitted, paid out, settled
 * or converted. They exist so that the control room (caps, tiers), halts,
 * screening and conversion can each plug in WITHOUT editing payment-service.ts:
 * a stream implements the hooks it owns in its own folder, and registers them
 * in its own slot file under `seams/slots/`.
 *
 * CONTRACT FOR AN IMPLEMENTATION
 *   - A guard REFUSES by throwing a typed error. Returning normally means "proceed".
 *   - A guard that cannot reach what it needs to decide (a halt store, a cap
 *     row) must throw, not return. Unreadable = refused.
 *   - Hooks may run more than once for one request (transaction retries, crash
 *     recovery). They must be idempotent and must not move value themselves;
 *     value moves only through packages/ledger-client.
 *   - Guards given a `tx` run INSIDE the caller's transaction, so a row lock
 *     taken there holds until the admission commits. That is what makes a cap
 *     exact under concurrency.
 *
 * LOCK ORDER (every payment-admission path, identity admission on or off, REST,
 * tRPC and public checkout alike). A guard that takes a row lock MUST be able to
 * rely on this order, so that it can never deadlock with a money path:
 *
 *     1. link row          (public checkout only: `payment_links ... FOR UPDATE`)
 *     2. merchant row      (`pay.merchants ... FOR SHARE`, the eligibility lock)
 *     3. >>> beforePaymentAdmit <<<     (the guard's own row locks come here)
 *     4. payment row       (INSERT for payment.create, FOR UPDATE for authorize/capture)
 *     5. rail and ledger calls
 *     6. >>> afterPaymentCaptureBooked <<<   (capture only: the guard's counter row
 *        locks are taken here, LAST, so they are held for a few statements and
 *        never across a rail or ledger call; see the hook's context below)
 *
 * Concretely: `beforePaymentAdmit` always runs inside the transaction that
 * performs the effect, AFTER the merchant lock is held and BEFORE the payment row
 * is inserted or locked. With identity admission on, that transaction is the one
 * that follows the identity grant (a locked row is never held across the identity
 * call); a guard refusal there does not undo the grant, so a retry re-runs the
 * guard. `beforeRefund` runs before the payment row lock for the same reason (it
 * has no merchant lock today, so it is the first lock taken). A guard must never
 * take a lock that ranks earlier than the ones it is given (never lock a link or
 * a merchant row itself on these paths), and must take its own locks in a fixed
 * order among themselves.
 *
 * REPLAY AND RECOVERY. Every context carries `replay`, which says whether value
 * has already moved for this business key:
 *   - `{ kind: 'fresh' }`            nothing has moved yet for this key: new work
 *                                    being admitted, or admitted work about to
 *                                    start moving value.
 *   - `{ kind: 'replay', reason }`   an idempotent repeat of work that is already
 *                                    complete; the call will do nothing new.
 *   - `{ kind: 'recovery', reason }` finishing work whose value may already be in
 *                                    flight (a booked hold, a frozen window, a
 *                                    held withdrawal) after a crash or a retry.
 * RULE FOR EVERY GUARD:
 *   - CAPS, LIMITS AND TIERS never refuse a replay or a recovery, and never count a
 *     replay. The rail already moved that money (or the first call already counted
 *     it); refusing it strands funds between the rail and the book. Count once, in
 *     the admit hook (`beforePayoutAdmit`), not in the execute hook that resumes
 *     it. The one exception is a payment CAPTURE: intake is counted in
 *     `afterPaymentCaptureBooked`, after the ledger post, and a capture is NEVER
 *     refused by a cap, fresh or not (its money has moved or is about to; see the
 *     capture note below). A recovered capture whose count rolled back with the
 *     transaction is counted there, once.
 *   - HALTS and screening MAY refuse `fresh` work (and a replay, which does
 *     nothing). A `recovery` that is BOOKKEEPING ONLY (a settlement post, a
 *     payment capture) MUST finish: refusing it leaves a frozen window or a
 *     captured payment half recorded. A `recovery` that would SEND to a rail
 *     (`beforePayoutExecute`) is refused by a PAYOUT halt, because a halt that
 *     lets merchant proceeds leave is not a halt. A personal withdrawal is not
 *     that exit: settlement credits proceeds. The booked hold is
 *     untouched, so that operation is paused, not stranded: nothing is released
 *     or marked failed, and the same call completes once the halt clears. A guard
 *     that refuses a rail-send recovery must therefore refuse BEFORE the hold is
 *     posted or the rail is asked, and the caller must treat that refusal as
 *     retry-later, never as a terminal failure.
 *   - `replay` is classified from durable state read in the same transaction (or
 *     the ledger, by business key). Where state cannot prove value moved it is
 *     `fresh`: a rail capture whose ledger post rolled back leaves no trace, and
 *     neither does a refund whose ledger post committed but whose reply was lost.
 *     INTAKE CAPS COUNT CAPTURED VOLUME, never created payments: public checkout
 *     lets anyone create a payment, so counting at create would let a stranger fill a
 *     merchant's caps. Create only refuses read-only when the headroom is already
 *     gone. The count itself happens in `afterPaymentCaptureBooked`. A capture is
 *     classified `fresh` even when the payer's money has already moved (a rail
 *     capture whose ledger post rolled back, a `captured` webhook or chain-watcher
 *     event), so a cap refusal at capture would strand those funds in `authorized`.
 *     A capture past a cap is therefore counted and FLAGGED for ops, not refused,
 *     and the create-time headroom check is the only enforcement point (a cap can
 *     be overshot by payments created before it filled). The count is keyed by
 *     payment id, so it is exact once however often the capture runs.
 *     The refund guard stays halts only.
 *   - `replay` is read BEFORE the payment row is locked, so two concurrent first
 *     calls for one payment (two authorizes racing) can BOTH see `fresh`; the
 *     loser then finds the work done and commits without moving value. A cap
 *     that adds to a counter must therefore count idempotently by business key
 *     (kind + paymentId, settlementId + attempt), never by call, or it
 *     over-counts and refuses later legitimate work.
 *
 * The defaults below are no-ops that preserve behaviour from before the seams.
 *
 * REFUSING: throw `PayGuardRefusal`. Anything else a guard throws (a raw Error,
 * a PayError, a driver error) is turned into `pay.guard_unavailable` by
 * `composeGuards`, so an unexpected failure refuses closed and its message never
 * reaches a client. Postgres serialization/deadlock errors are the one exception:
 * they pass through untouched so the surrounding transaction can retry.
 */

/**
 * The one error a guard may throw to refuse. `code` reaches the client
 * (`error.data.cause.code`); the message is the code, never internals.
 *   - `refused`     a rule said no (cap, screening block): FORBIDDEN.
 *   - `unavailable` the guard could not decide or a scope is halted: SERVICE_UNAVAILABLE.
 */
export class PayGuardRefusal extends Error {
  /**
   * Best-effort follow-up a guard wants run AFTER the refusal, once the caller's
   * transaction has rolled back and every lock it held is released (for example
   * voiding a stale approval, which needs a second pool connection). A guard
   * must not open that connection itself while it still holds the caller's
   * locks. The caller that owns the transaction runs it with
   * `settleGuardRefusal`, outside the transaction; a caller that does not simply
   * never runs it, and the refusal is unchanged either way.
   */
  afterRollback?: () => Promise<void>;
  constructor(
    readonly code: `pay.guard_${string}`,
    readonly kind: 'refused' | 'unavailable',
    /** Allowance left, as decimal strings, when the refusal is a limit (D-148). */
    readonly remaining?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = 'PayGuardRefusal';
  }
}

/**
 * A guard refusal on a tRPC door: typed, never the PayError default (BAD_REQUEST reads as "fix your request"). The message
 * is the code only: composeGuards already stripped any internals. `unavailable` is SERVICE_UNAVAILABLE, a refusal FORBIDDEN.
 */
export function guardRefusalToTrpc(err: PayGuardRefusal): TRPCError {
  return new TRPCError({ code: err.kind === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN', message: err.code, cause: err });
}

/** Run a refusal's `afterRollback` follow-up, if any. Never throws: a failed follow-up must not change the refusal. */
export async function settleGuardRefusal(error: unknown): Promise<void> {
  if (!(error instanceof PayGuardRefusal) || !error.afterRollback) return;
  const followUp = error.afterRollback;
  error.afterRollback = undefined;
  try {
    await followUp();
  } catch {
    // Best effort by contract.
  }
}

const RETRYABLE_PG = new Set(['40001', '40P01']);

/** Fail closed: everything a guard throws becomes a typed refusal, except a retryable Postgres error. */
function toRefusal(error: unknown): unknown {
  if (error instanceof PayGuardRefusal) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && RETRYABLE_PG.has(code)) return error;
  const refusal = new PayGuardRefusal('pay.guard_unavailable', 'unavailable');
  // Kept for server-side logs only; not a field the error formatter reads.
  Object.defineProperty(refusal, 'internal', { value: error, enumerable: false });
  return refusal;
}

/** Why a call is not fresh. Closed list, so a guard can switch on it. */
export type GuardReplayReason =
  | 'payment_exists'
  | 'already_authorized'
  | 'already_captured'
  | 'ledger_already_booked'
  | 'refund_already_completed'
  | 'window_already_frozen'
  | 'window_frozen_not_posted'
  | 'payout_hold_booked'
  | 'withdrawal_already_sent'
  | 'withdrawal_rail_outcome_recorded'
  | 'withdrawal_hold_booked'
  /** An internal withdrawal (W-withdraw-14) whose send was asked of svc-bank and whose answer is not on record. */
  | 'withdrawal_internal_send_asked';

/** Fresh admission, an idempotent repeat, or the finishing of work already admitted. See REPLAY AND RECOVERY above. */
export type GuardReplay = { readonly kind: 'fresh' } | { readonly kind: 'replay' | 'recovery'; readonly reason: GuardReplayReason };

export const FRESH: GuardReplay = Object.freeze({ kind: 'fresh' as const });

/** Context for `beforePaymentAdmit`; runs inside the admission transaction. */
export interface PaymentAdmitContext {
  readonly tx: Sql;
  readonly kind: 'payment.create' | 'payment.authorize' | 'payment.capture';
  readonly paymentId: string;
  readonly merchantId: string;
  /** The canonical admitted payload (amounts are decimal strings). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly replay: GuardReplay;
}

/**
 * Context for `afterPaymentCaptureBooked`. Runs inside the capture transaction AFTER the
 * ledger post and just before the payment row is marked `captured`, so a row lock taken
 * here is held for a few statements, never across the rail or ledger call. The money has
 * moved: a guard here must not refuse for a cap or a limit (only an infrastructure
 * failure may throw, which rolls the transaction back and lets the capture be retried as
 * a recovery). Counting must be idempotent by `paymentId`.
 */
export interface PaymentCaptureBookedContext {
  readonly tx: Sql;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly assetId: string;
  readonly amount: Amount;
  /**
   * When set, intake is counted on this instant's day and month. The
   * authorized-capture reconciler passes the ledger transaction's postedAt so a
   * capture booked earlier is not charged to the run. A live capture omits it.
   */
  readonly at?: Date;
}

/** Context for `beforePayoutAdmit`; runs inside the transaction that records a NEW payout admission. */
export interface PayoutAdmitContext {
  readonly tx: Sql;
  readonly settlementId: string;
  readonly merchantId: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly railId: string;
  readonly destination: { readonly kind: string; readonly ref: string };
  readonly attempt: number;
  /** Always `fresh`: this hook only runs when a NEW admission is recorded. */
  readonly replay: GuardReplay;
}

/**
 * Context for `beforePayoutExecute`. Runs before any hold is posted or rail is
 * asked, for a first attempt AND for crash recovery of an already-admitted
 * payout, so a halt stops in-flight work as well as new work.
 */
export interface PayoutExecuteContext {
  readonly sql: Sql;
  readonly settlementId: string;
  readonly merchantId: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly railId: string;
  readonly destination: { readonly kind: string; readonly ref: string };
  readonly attempt: number;
  /** `recovery` when the payout's hold is already booked on the ledger (a resumed payout), otherwise `fresh`: nothing has moved yet. */
  readonly replay: GuardReplay;
}

/** Context for `beforeSettlementRun`. `prepare` = freezing a window; `post` = posting a frozen one to the ledger. */
export interface SettlementRunContext {
  readonly sql: Sql;
  readonly phase: 'prepare' | 'post';
  readonly merchantId?: string;
  readonly assetId?: string;
  readonly window?: string;
  readonly settlementId?: string;
  readonly replay: GuardReplay;
}

/**
 * Context for `beforeConversion`. Runs inside the order-intent transaction, before
 * that transaction commits and before any venue call. A refusal rolls the intent
 * back: no client order id is kept, so nothing is left to place on a retry.
 * `tx` is that transaction. The pool (`sql`) is not a lock.
 */
export interface ConversionContext {
  readonly sql: Sql;
  readonly tx: Sql;
  readonly merchantId: string;
  readonly settlementId: string;
  readonly fromAsset: string;
  readonly toAsset: string;
  readonly fromAmount: Amount;
  readonly replay: GuardReplay;
}

/**
 * Context for `beforeRefund`. Runs inside the refund's first transaction, before
 * the payment row lock, before the merchant is debited and before any rail call.
 * A refusal rolls that transaction back: nothing is recorded or moved.
 */
export interface RefundContext {
  readonly tx: Sql;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly assetId: string;
  readonly amount: Amount;
  /** The caller's business key when it gave one; absent for an ordinal refund. */
  readonly refundId?: string;
  /** `replay` when `refundId` names a refund that already completed; otherwise `fresh`. */
  readonly replay: GuardReplay;
}

/**
 * Context for `beforeUserMoneyWithdrawal` (a user moving their own balance off the
 * platform). Runs inside the transaction that claims `(userId, clientRef)`, before
 * the claim row is written, so a refusal leaves no claim, hold or ledger entry.
 */
export interface UserMoneyWithdrawalContext {
  readonly tx: Sql;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly rail: string;
  readonly destination: { readonly kind: string; readonly ref: string };
  readonly clientRef: string;
  /** True when this claim only places the hold and stops (approval hold at submission); the row is never sent by this call. */
  readonly stopAfterHold?: boolean;
  /** `replay` for a sent withdrawal, `recovery` once the hold is booked (held, or pending with the hold on the ledger), otherwise `fresh`. */
  readonly replay: GuardReplay;
}

export interface PayGuards {
  beforePaymentAdmit(ctx: PaymentAdmitContext): Promise<void>;
  afterPaymentCaptureBooked(ctx: PaymentCaptureBookedContext): Promise<void>;
  beforePayoutAdmit(ctx: PayoutAdmitContext): Promise<void>;
  beforePayoutExecute(ctx: PayoutExecuteContext): Promise<void>;
  beforeSettlementRun(ctx: SettlementRunContext): Promise<void>;
  beforeConversion(ctx: ConversionContext): Promise<void>;
  beforeRefund(ctx: RefundContext): Promise<void>;
  beforeUserMoneyWithdrawal(ctx: UserMoneyWithdrawalContext): Promise<void>;
}

export type PayGuardName = keyof PayGuards;
export const PAY_GUARD_NAMES = [
  'beforePaymentAdmit',
  'afterPaymentCaptureBooked',
  'beforePayoutAdmit',
  'beforePayoutExecute',
  'beforeSettlementRun',
  'beforeConversion',
  'beforeRefund',
  'beforeUserMoneyWithdrawal',
] as const satisfies readonly PayGuardName[];

/** What a stream's slot file returns: only the hooks it implements. */
export type PartialPayGuards = Partial<PayGuards>;

const noop = async (): Promise<void> => undefined;

/** Today's behaviour exactly: every hook proceeds. */
export const NOOP_GUARDS: PayGuards = Object.freeze({
  beforePaymentAdmit: noop,
  afterPaymentCaptureBooked: noop,
  beforePayoutAdmit: noop,
  beforePayoutExecute: noop,
  beforeSettlementRun: noop,
  beforeConversion: noop,
  beforeRefund: noop,
  beforeUserMoneyWithdrawal: noop,
});

/**
 * Combine implementations. For each hook, every implementation runs in the
 * order given and the first to throw refuses; later ones do not run. What it
 * threw is normalised by `toRefusal` (fail closed, no leaked message). A hook no
 * part implements stays a no-op.
 */
export function composeGuards(...parts: readonly PartialPayGuards[]): PayGuards {
  const run = <C>(name: PayGuardName) => {
    const chain = parts.map((p) => p[name]).filter((fn): fn is NonNullable<typeof fn> => typeof fn === 'function');
    if (chain.length === 0) return noop;
    return async (ctx: C): Promise<void> => {
      for (const fn of chain) {
        try {
          await (fn as (c: C) => Promise<void>)(ctx);
        } catch (error) {
          throw toRefusal(error);
        }
      }
    };
  };
  return {
    beforePaymentAdmit: run<PaymentAdmitContext>('beforePaymentAdmit'),
    afterPaymentCaptureBooked: run<PaymentCaptureBookedContext>('afterPaymentCaptureBooked'),
    beforePayoutAdmit: run<PayoutAdmitContext>('beforePayoutAdmit'),
    beforePayoutExecute: run<PayoutExecuteContext>('beforePayoutExecute'),
    beforeSettlementRun: run<SettlementRunContext>('beforeSettlementRun'),
    beforeConversion: run<ConversionContext>('beforeConversion'),
    beforeRefund: run<RefundContext>('beforeRefund'),
    beforeUserMoneyWithdrawal: run<UserMoneyWithdrawalContext>('beforeUserMoneyWithdrawal'),
  };
}
