import type { Sql } from 'postgres';
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
  constructor(
    readonly code: `pay.guard_${string}`,
    readonly kind: 'refused' | 'unavailable',
  ) {
    super(code);
    this.name = 'PayGuardRefusal';
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

/** Context for `beforePaymentAdmit`; runs inside the admission transaction. */
export interface PaymentAdmitContext {
  readonly tx: Sql;
  readonly kind: 'payment.create' | 'payment.authorize' | 'payment.capture';
  readonly paymentId: string;
  readonly merchantId: string;
  /** The canonical admitted payload (amounts are decimal strings). */
  readonly payload: Readonly<Record<string, unknown>>;
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
}

/** Context for `beforeSettlementRun`. `prepare` = freezing a window; `post` = posting a frozen one to the ledger. */
export interface SettlementRunContext {
  readonly sql: Sql;
  readonly phase: 'prepare' | 'post';
  readonly merchantId?: string;
  readonly assetId?: string;
  readonly window?: string;
  readonly settlementId?: string;
}

/** Context for `beforeConversion`. NOT CALLED YET: the conversion path (W6) does not exist. */
export interface ConversionContext {
  readonly sql: Sql;
  readonly merchantId: string;
  readonly settlementId: string;
  readonly fromAsset: string;
  readonly toAsset: string;
  readonly fromAmount: Amount;
}

export interface PayGuards {
  beforePaymentAdmit(ctx: PaymentAdmitContext): Promise<void>;
  beforePayoutAdmit(ctx: PayoutAdmitContext): Promise<void>;
  beforePayoutExecute(ctx: PayoutExecuteContext): Promise<void>;
  beforeSettlementRun(ctx: SettlementRunContext): Promise<void>;
  beforeConversion(ctx: ConversionContext): Promise<void>;
}

export type PayGuardName = keyof PayGuards;
export const PAY_GUARD_NAMES = [
  'beforePaymentAdmit',
  'beforePayoutAdmit',
  'beforePayoutExecute',
  'beforeSettlementRun',
  'beforeConversion',
] as const satisfies readonly PayGuardName[];

/** What a stream's slot file returns: only the hooks it implements. */
export type PartialPayGuards = Partial<PayGuards>;

const noop = async (): Promise<void> => undefined;

/** Today's behaviour exactly: every hook proceeds. */
export const NOOP_GUARDS: PayGuards = Object.freeze({
  beforePaymentAdmit: noop,
  beforePayoutAdmit: noop,
  beforePayoutExecute: noop,
  beforeSettlementRun: noop,
  beforeConversion: noop,
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
    beforePayoutAdmit: run<PayoutAdmitContext>('beforePayoutAdmit'),
    beforePayoutExecute: run<PayoutExecuteContext>('beforePayoutExecute'),
    beforeSettlementRun: run<SettlementRunContext>('beforeSettlementRun'),
    beforeConversion: run<ConversionContext>('beforeConversion'),
  };
}
