import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { merchantIdsWithLegacySettlement, type SettlementBookReader } from '../settlement-book.js';
import type { PartialPayGuards, PaymentAdmitContext, PaymentCaptureBookedContext } from '../seams/guards.js';
import { recordMerchantNotification, type NewNotification } from '../merchant-ops/notifications.js';
import { enqueueHeldPayment } from '../fraud/review-queue-store.js';
import { writeAudit } from './audit.js';
import { emitCapturedOverCap, type CapturedOverCapSignal } from './over-cap-signal.js';
import { requirePayoutApproval } from './approval-gate.js';
import { alreadyCounted, consumeBeneficiary, consumeMoney, markCounted, readUsage } from './counters.js';
import { ControlRefusal } from './errors.js';
import type { MerchantControlsMode } from './mode.js';
import { computePricing, computeReserve, PricingConfigError, resolvePricingRule, type ResolvedRule } from './pricing.js';
import { writePricingSnapshot } from './snapshots.js';
import {
  countCapLimit,
  dayKey,
  effectiveCaps,
  effectiveReserve,
  loadApplicableRules,
  loadMerchantControl,
  monthKey,
  monthlyIntake,
  moneyCapLimit,
  type MerchantControl,
  type TierConfig,
} from './store.js';

/**
 * W1 GUARDS (registered in seams/slots/w1-control.ts).
 *
 * Rules these hooks follow, from seams/guards.ts:
 *  - Counted ONCE per business key (the day is part of every money key, so a retry
 *    on a later day is counted on its own day and a same-day retry stays free):
 *      intake       `payment.capture:<paymentId>`   (CAPTURED volume, in `afterPaymentCaptureBooked`)
 *      daily_payout `payout:<settlementId>:<day>`   (once per settlement per day, not per attempt)
 *      daily_payout `withdrawal:<merchantId>:<userId>:<clientRef>:<day>` (an owner's user-money exit)
 *  - A replay is never refused and never counted. A recovery is never refused.
 *  - INTAKE IS CAPTURED VOLUME, NOT CREATED PAYMENTS. Public checkout lets anyone
 *    create a payment, so counting at create would let a stranger fill a merchant's
 *    caps or push its pricing band without paying. Create checks the config exists,
 *    the single-payment bound (no counter) and, read-only, that the caps still have
 *    room: that is the ONLY point a cap refuses intake. The counters move at capture,
 *    after the ledger post, and a capture is never refused (its money has moved, or a
 *    webhook or chain watcher says it has): one over a cap is counted and FLAGGED
 *    (`payment.captured_over_cap` in `pay.control_audit`) for ops.
 *  - Row locks (the cap counters) are taken inside the caller's transaction. Payout
 *    and withdrawal admissions take them after the merchant lock and the treasury
 *    lock; the capture counter is taken LAST in the capture transaction, after the
 *    rail and ledger calls, with a 2s lock timeout. Always daily, then monthly.
 *  - Nothing unconfigured gets a default: no tier, no cap, no rule, no
 *    threshold = a typed refusal and nothing moves.
 *  - Anything unreadable refuses (`pay.control_unreadable`, unavailable).
 */

export interface ControlGuardDeps {
  /** `off`: every hook is a no-op (today's behaviour). `required`: enforce. See mode.ts. */
  readonly mode: MerchantControlsMode;
  /** The pool. Used only for the idempotent void of a stale approval, which must survive a rollback. */
  readonly sql: Sql;
  readonly now?: () => Date;
  /** Over-cap notice failures. Omitted: the boot logger set by `setOverCapNoticeLogger`. */
  readonly warn?: (fields: Record<string, unknown>, message: string) => void;
  /** Settlement-key reader. Absent: a posted window counts as legacy (fail closed). */
  readonly ledger?: SettlementBookReader;
}

type NoticeWarn = (fields: Record<string, unknown>, message: string) => void;
let overCapNoticeWarn: NoticeWarn = () => undefined;

/** Wired from the service log at boot. Read when a notice insert fails, not when the guards are built. */
export function setOverCapNoticeLogger(warn: NoticeWarn): void {
  overCapNoticeWarn = warn;
}

const RETRYABLE_PG = new Set(['40001', '40P01']);

function requireTier(control: MerchantControl): TierConfig {
  if (!control.tier) throw new ControlRefusal('pay.tier_unassigned');
  return control.tier;
}

async function requireRule(q: Sql, control: MerchantControl, merchantId: string, assetCode: string): Promise<ResolvedRule> {
  const candidates = await loadApplicableRules(q, merchantId, control.tier?.id ?? null, assetCode);
  const resolved = resolvePricingRule(candidates, assetCode);
  if (!resolved) throw new ControlRefusal('pay.pricing_unconfigured');
  return resolved;
}

function wrapConfig<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof PricingConfigError) {
      const refusal = new ControlRefusal('pay.control_unreadable', 'unavailable');
      Object.defineProperty(refusal, 'internal', { value: error, enumerable: false });
      throw refusal;
    }
    throw error;
  }
}

function readPaymentPayload(payload: Readonly<Record<string, unknown>>): { assetCode: string; amount: Amount } {
  const assetCode = payload.assetId;
  const amount = payload.amount;
  if (typeof assetCode !== 'string' || assetCode === '' || typeof amount !== 'string') {
    throw new ControlRefusal('pay.control_unreadable', 'unavailable');
  }
  return { assetCode, amount: parseAmount(amount) };
}

function intakeLimits(control: MerchantControl, assetCode: string): { perPayment: Amount; daily: Amount; monthly: Amount } {
  const caps = effectiveCaps(control) ?? [];
  const perPayment = moneyCapLimit(caps, 'per_payment', assetCode);
  const daily = moneyCapLimit(caps, 'daily_intake', assetCode);
  const monthly = moneyCapLimit(caps, 'monthly_intake', assetCode);
  if (perPayment === null || daily === null || monthly === null) throw new ControlRefusal('pay.caps_unconfigured');
  return { perPayment, daily, monthly };
}

/**
 * Bound the wait on a counter row lock. A timeout (55P03) is not retryable inside this
 * transaction, so it surfaces as `pay.guard_unavailable` (SERVICE_UNAVAILABLE, retry later),
 * the capture rolls back, and the retry finishes it as a recovery.
 */
async function withCounterLockTimeout<T>(tx: Sql, fn: () => Promise<T>): Promise<T> {
  const rows = await tx<Array<{ prev: string }>>`SELECT current_setting('lock_timeout') AS prev`;
  await tx`SELECT set_config('lock_timeout', '2s', true)`;
  const result = await fn();
  await tx`SELECT set_config('lock_timeout', ${rows[0]!.prev}, true)`;
  return result;
}

/** The notice savepoint could not be rolled back. The capture transaction is unusable. */
class NoticeSavepointLost extends Error {
  constructor() {
    super('over-cap notice savepoint could not be restored');
    this.name = 'NoticeSavepointLost';
  }
}

/**
 * Insert the over-cap notice in a savepoint. A failure is thrown after the
 * savepoint is gone, so the caller can log it and keep the capture.
 */
async function insertOverCapNotice(tx: Sql, notice: NewNotification): Promise<void> {
  const beginTx = tx as Sql & { savepoint?: (fn: (sql: Sql) => Promise<void>) => Promise<void> };
  if (typeof beginTx.savepoint === 'function') {
    await beginTx.savepoint(async (sp) => {
      await recordMerchantNotification(sp, notice);
    });
    return;
  }
  await tx`SAVEPOINT pay_over_cap_notice`;
  try {
    await recordMerchantNotification(tx, notice);
    await tx`RELEASE SAVEPOINT pay_over_cap_notice`;
  } catch (error) {
    try {
      await tx`ROLLBACK TO SAVEPOINT pay_over_cap_notice`;
      await tx`RELEASE SAVEPOINT pay_over_cap_notice`;
    } catch {
      throw new NoticeSavepointLost();
    }
    throw error;
  }
}

/** Event kind for "this payout attempt was admitted"; carries no amount (the amount is counted once per settlement). */
const PAYOUT_ATTEMPT_MARKER = 'payout_attempt';

const destinationKey = (d: { kind: string; ref: string }): string => `${d.kind.trim().toLowerCase()}:${d.ref.trim().toLowerCase()}`;

export function createControlGuards(deps: ControlGuardDeps): PartialPayGuards {
  // Off = exactly today: no counters, no snapshots, no refusals.
  if (deps.mode === 'off') return {};
  const now = deps.now ?? (() => new Date());

  /**
   * Payment CREATE: counts nothing. Anyone can create a payment through public checkout, so a created
   * payment is not volume. Checks, read-only and lock-free: the config is there (nothing unconfigured
   * is defaulted), the amount is within the single-payment bound, and the day and month caps still
   * have room for it (so a payer is not sent to pay a merchant whose cap capture would refuse).
   */
  async function admitCreate(ctx: PaymentAdmitContext): Promise<void> {
    if (ctx.replay.kind !== 'fresh') return;
    const { tx } = ctx;
    const { assetCode, amount } = readPaymentPayload(ctx.payload);
    const control = await loadMerchantControl(tx, ctx.merchantId);
    requireTier(control);
    const { perPayment, daily, monthly } = intakeLimits(control, assetCode);
    await requireRule(tx, control, ctx.merchantId, assetCode);
    if (amount > perPayment) throw new ControlRefusal('pay.cap_per_payment_exceeded');
    const at = now();
    if ((await readUsage(tx, ctx.merchantId, 'daily_intake', assetCode, dayKey(at))) + amount > daily)
      throw new ControlRefusal('pay.cap_daily_intake_exceeded');
    if ((await readUsage(tx, ctx.merchantId, 'monthly_intake', assetCode, monthKey(at))) + amount > monthly)
      throw new ControlRefusal('pay.cap_monthly_intake_exceeded');
  }

  /**
   * Payment CAPTURE, after the ledger post (`afterPaymentCaptureBooked`): the one place intake is
   * counted. NEVER refuses for a cap, the per-payment bound included: a capture is classified fresh
   * even when the payer's money has already moved (a rail capture whose ledger post rolled back, a
   * webhook, a chain-watcher event), and refusing it would strand that money in `authorized`. A
   * capture over a cap is counted and flagged for ops instead; create-time headroom is the only gate.
   * The counter row locks are taken here, last, so they never span a rail or ledger call, and a
   * wait on one is bounded (a timeout rolls the capture back to be retried as a recovery).
   */
  async function countCapture(ctx: PaymentCaptureBookedContext): Promise<void> {
    const { tx, assetCode, amount } = { tx: ctx.tx, assetCode: ctx.assetId, amount: ctx.amount };
    const eventKey = `payment.capture:${ctx.paymentId.toLowerCase()}`;
    // Already counted by an earlier call (two racing first calls, or a recovery): done.
    if (await alreadyCounted(tx, eventKey, 'daily_intake')) return;

    let limits: { perPayment: Amount; daily: Amount; monthly: Amount } | null = null;
    let resolved: ResolvedRule | null = null;
    try {
      const control = await loadMerchantControl(tx, ctx.merchantId);
      requireTier(control);
      limits = intakeLimits(control, assetCode);
      resolved = await requireRule(tx, control, ctx.merchantId, assetCode);
    } catch (error) {
      // Config removed or unreadable since the payment was created: the capture still finishes.
      if (!(error instanceof ControlRefusal)) throw error;
    }

    const at = ctx.at instanceof Date && Number.isFinite(ctx.at.getTime()) ? ctx.at : now();
    const [dailyResult, monthlyResult] = await withCounterLockTimeout(tx, async () => [
      await consumeMoney(tx, {
        merchantId: ctx.merchantId,
        kind: 'daily_intake',
        assetCode,
        periodKey: dayKey(at),
        eventKey,
        amount,
        limit: limits?.daily ?? 0n,
        enforce: false,
      }),
      await consumeMoney(tx, {
        merchantId: ctx.merchantId,
        kind: 'monthly_intake',
        assetCode,
        periodKey: monthKey(at),
        eventKey,
        amount,
        limit: limits?.monthly ?? 0n,
        enforce: false,
      }),
    ]);
    if (!dailyResult.counted && !monthlyResult.counted) return;

    const over: string[] = [];
    if (!limits) over.push('config_missing');
    else {
      if (amount > limits.perPayment) over.push('per_payment');
      if (dailyResult.usedBefore + amount > limits.daily) over.push('daily_intake');
      if (monthlyResult.usedBefore + amount > limits.monthly) over.push('monthly_intake');
    }
    let overCap: CapturedOverCapSignal | null = null;
    if (over.length > 0) {
      const amountText = formatAmount(amount);
      await writeAudit(tx, {
        scope: 'merchant',
        scopeId: ctx.merchantId,
        merchantId: ctx.merchantId,
        kind: 'payment.captured_over_cap',
        outcome: 'flagged',
        actorId: 'system:capture_guard',
        reason: `captured payment exceeded: ${over.join(', ')}`,
        after: { paymentId: ctx.paymentId, assetCode, amount: amountText, exceeded: over },
      });
      await enqueueHeldPayment(tx, {
        paymentRef: ctx.paymentId,
        merchantId: ctx.merchantId,
        amount: amountText,
        assetId: assetCode,
        reason: `captured payment exceeded: ${over.join(', ')}`,
        reasons: over.map((code) => ({ ruleId: 'captured_over_cap', detail: code })),
        createdBy: 'system:capture_guard',
        source: 'control.captured_over_cap',
      });
      // Same transaction as the audit row, but its own savepoint: a notice-table
      // failure must not roll back a capture whose ledger post already landed.
      // A muted `limit_threshold` preference records nothing and does not stop
      // the metric or the span event.
      //
      // `sql.begin` remembers every rejected statement and rolls the transaction
      // back at the end, even when the caller caught it. Its savepoint helper is
      // the one that rolls back only the notice. The reconciler's reserved
      // connection has no such tracker, so it uses a named savepoint directly.
      try {
        await insertOverCapNotice(tx, {
          merchantId: ctx.merchantId,
          kind: 'limit_threshold',
          title: 'Capture exceeded a cap',
          body: `${amountText} ${assetCode} exceeded ${over.join(', ')}`,
          subjectType: 'payment',
          subjectId: ctx.paymentId,
          dedupeKey: `captured_over_cap:${ctx.paymentId.toLowerCase()}`,
        });
      } catch (error) {
        if (error instanceof NoticeSavepointLost) throw error;
        const fields = {
          event: 'payment.captured_over_cap_notice_failed',
          paymentId: ctx.paymentId,
          merchantId: ctx.merchantId,
          err: error instanceof Error ? error.message : 'notification failed',
        };
        try {
          (deps.warn ?? overCapNoticeWarn)(fields, 'over-cap notification failed');
        } catch {
          // A broken logger must not roll back a capture whose ledger post landed.
        }
      }
      overCap = { paymentId: ctx.paymentId, merchantId: ctx.merchantId, assetCode, amount: amountText, exceeded: over };
    }

    const signalOverCap = () => {
      if (overCap) emitCapturedOverCap(overCap);
    };

    // The pricing snapshot is bookkeeping: a rule that is gone or cannot be computed skips it, never the capture.
    // The counter is emitted on the way out of this function, after the audit insert. A throw from the
    // snapshot skips it. A throw in the caller after this returns can still lead the process counter;
    // the audit row is what committed.
    if (!resolved) {
      signalOverCap();
      return;
    }
    const rule = resolved;
    let quote;
    try {
      quote = computePricing(rule.rule, { amount, monthlyVolumeBefore: monthlyResult.usedBefore });
    } catch (error) {
      if (error instanceof PricingConfigError) {
        signalOverCap();
        return;
      }
      throw error;
    }
    await writePricingSnapshot(tx, {
      subjectKind: 'payment',
      subjectId: ctx.paymentId,
      merchantId: ctx.merchantId,
      assetCode,
      resolved: rule,
      quote,
      baseAmount: amount,
      monthlyVolumeBefore: monthlyResult.usedBefore,
    });
    signalOverCap();
  }

  return {
    async beforePaymentAdmit(ctx) {
      // Authorize moves nothing and is halts' business only.
      if (ctx.kind === 'payment.authorize') return;
      if (ctx.kind === 'payment.create') return admitCreate(ctx);
      // Capture: nothing before the rail. Counted after the ledger post (afterPaymentCaptureBooked).
    },

    afterPaymentCaptureBooked: countCapture,

    async beforePayoutAdmit(ctx) {
      if (ctx.replay.kind !== 'fresh') return;
      const { tx } = ctx;
      // One admission per attempt. The attempt marker makes a racing repeat of the SAME attempt a no-op.
      const attemptKey = `payout:${ctx.settlementId.toLowerCase()}:${ctx.attempt}`;
      if (await alreadyCounted(tx, attemptKey, PAYOUT_ATTEMPT_MARKER)) return;

      const control = await loadMerchantControl(tx, ctx.merchantId);
      const tier = requireTier(control);
      const caps = effectiveCaps(control) ?? [];
      const dailyPayout = moneyCapLimit(caps, 'daily_payout', ctx.assetId);
      const beneficiaries = countCapLimit(caps);
      if (dailyPayout === null || beneficiaries === null) throw new ControlRefusal('pay.caps_unconfigured');
      const approvalThreshold = tier.approvalThresholds.get(ctx.assetId);
      const founderThreshold = tier.founderThresholds.get(ctx.assetId);
      if (approvalThreshold === undefined || founderThreshold === undefined)
        throw new ControlRefusal('pay.approval_threshold_unconfigured');

      const at = now();
      // Approval is checked on EVERY attempt: a retry may name a different destination, and an
      // approval is single-use per attempt (approval-gate.ts).
      if (ctx.amount >= approvalThreshold) {
        await requirePayoutApproval(
          tx,
          deps.sql,
          {
            merchantId: ctx.merchantId,
            settlementId: ctx.settlementId,
            assetCode: ctx.assetId,
            amount: ctx.amount,
            railId: ctx.railId,
            destination: ctx.destination,
          },
          ctx.attempt,
          at,
        );
      }

      // The settlement's money leaves once however many attempts it takes, so the amount is counted
      // ONCE per settlement id (a retry finds the key and adds nothing).
      await consumeMoney(tx, {
        merchantId: ctx.merchantId,
        kind: 'daily_payout',
        assetCode: ctx.assetId,
        periodKey: dayKey(at),
        eventKey: `payout:${ctx.settlementId.toLowerCase()}:${dayKey(at)}`,
        amount: ctx.amount,
        limit: dailyPayout,
      });
      await consumeBeneficiary(tx, {
        merchantId: ctx.merchantId,
        periodKey: dayKey(at),
        destination: destinationKey(ctx.destination),
        eventKey: attemptKey,
        limit: beneficiaries,
      });
      await markCounted(tx, {
        eventKey: attemptKey,
        kind: PAYOUT_ATTEMPT_MARKER,
        merchantId: ctx.merchantId,
        assetCode: ctx.assetId,
        periodKey: dayKey(at),
      });
    },

    /**
     * Personal `withdrawal.create` debits `userAvailable`. A pre-cutover
     * settlement debited that same account, so an owner could move that net
     * out and skip every payout control. The daily payout cap, beneficiary cap,
     * and approval threshold apply to each merchant the user owns that still
     * has such a settlement of THIS asset. A merchant whose posted windows all
     * debit proceeds is skipped: that net is not on this balance.
     *
     * An amount at or above the approval threshold is refused
     * `pay.approval_required`: a maker-checker approval is bound to a
     * settlement, and a withdrawal has none. Closed rather than open.
     */
    async beforeUserMoneyWithdrawal(ctx) {
      if (ctx.replay.kind !== 'fresh') return;
      const { tx } = ctx;
      let owned: string[];
      try {
        owned = await merchantIdsWithLegacySettlement(tx, deps.ledger, ctx.userId, ctx.assetId);
      } catch (error) {
        if (error instanceof ControlRefusal) throw error;
        if (RETRYABLE_PG.has((error as { code?: string } | null)?.code ?? '')) throw error;
        throw new ControlRefusal('pay.control_unreadable', 'unavailable');
      }
      if (owned.length === 0) return;
      const at = now();
      for (const merchantId of owned) {
        const control = await loadMerchantControl(tx, merchantId);
        const tier = requireTier(control);
        const caps = effectiveCaps(control) ?? [];
        const dailyPayout = moneyCapLimit(caps, 'daily_payout', ctx.assetId);
        const beneficiaries = countCapLimit(caps);
        if (dailyPayout === null || beneficiaries === null) throw new ControlRefusal('pay.caps_unconfigured');
        const approvalThreshold = tier.approvalThresholds.get(ctx.assetId);
        if (approvalThreshold === undefined) throw new ControlRefusal('pay.approval_threshold_unconfigured');
        if (ctx.amount >= approvalThreshold) throw new ControlRefusal('pay.approval_required');

        const eventKey = `withdrawal:${merchantId}:${ctx.userId.toLowerCase()}:${ctx.clientRef}:${dayKey(at)}`;
        await consumeMoney(tx, {
          merchantId,
          kind: 'daily_payout',
          assetCode: ctx.assetId,
          periodKey: dayKey(at),
          eventKey,
          amount: ctx.amount,
          limit: dailyPayout,
        });
        await consumeBeneficiary(tx, {
          merchantId,
          periodKey: dayKey(at),
          destination: destinationKey(ctx.destination),
          eventKey,
          limit: beneficiaries,
        });
      }
    },

    async beforeSettlementRun(ctx) {
      if (!ctx.merchantId && !ctx.settlementId) return;
      const fresh = ctx.replay.kind === 'fresh';

      if (ctx.phase === 'prepare') {
        // A window that already exists is a re-run: never refused here.
        if (!fresh || !ctx.merchantId || !ctx.assetId) return;
        const control = await loadMerchantControl(ctx.sql, ctx.merchantId);
        requireTier(control);
        await requireRule(ctx.sql, control, ctx.merchantId, ctx.assetId);
        return;
      }

      // phase 'post': freeze the pricing the settlement was made under.
      if (!ctx.settlementId) return;
      const rows = await ctx.sql<Array<{ merchant_id: string; asset_id: string; gross: string; fees: string; net: string }>>`
        SELECT merchant_id, asset_id, gross, fees, net FROM pay.settlements WHERE id = ${ctx.settlementId}
      `;
      const row = rows[0];
      if (!row) return;
      const existing =
        await ctx.sql`SELECT 1 FROM pay.control_pricing_snapshots WHERE subject_kind = 'settlement' AND subject_id = ${ctx.settlementId}`;
      if (existing.length > 0) return;

      const control = await loadMerchantControl(ctx.sql, row.merchant_id);
      let resolved: ResolvedRule;
      try {
        requireTier(control);
        resolved = await requireRule(ctx.sql, control, row.merchant_id, row.asset_id);
      } catch (error) {
        // Config removed between freeze and post: finishing frozen work is never refused.
        if (!fresh && error instanceof ControlRefusal && error.kind === 'refused') return;
        throw error;
      }
      const at = now();
      const gross = parseAmount(row.gross);
      const volume = await monthlyIntake(ctx.sql, row.merchant_id, row.asset_id, at);
      const quote = wrapConfig(() => computePricing(resolved.rule, { amount: gross, monthlyVolumeBefore: volume }));
      const reserveSetting = effectiveReserve(control);
      const reserve = reserveSetting
        ? wrapConfig(() => computeReserve(parseAmount(row.net), reserveSetting, resolved.rule.roundingBeneficiary, at))
        : null;
      await writePricingSnapshot(ctx.sql, {
        subjectKind: 'settlement',
        subjectId: ctx.settlementId,
        merchantId: row.merchant_id,
        assetCode: row.asset_id,
        resolved,
        quote,
        baseAmount: gross,
        monthlyVolumeBefore: volume,
        bookedFee: parseAmount(row.fees),
        reserve,
      });
    },
  };
}

export { formatAmount };
