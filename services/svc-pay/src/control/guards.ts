import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { PartialPayGuards, PaymentAdmitContext } from '../seams/guards.js';
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
 *  - Counted ONCE per business key, in the admit hooks only:
 *      intake       `payment.capture:<paymentId>`   (CAPTURED volume, see below)
 *      daily_payout `payout:<settlementId>`         (once per settlement, not per attempt)
 *      daily_payout `withdrawal:<merchantId>:<userId>:<clientRef>` (an owner's user-money exit)
 *  - A replay is never refused and never counted. A recovery is never refused; a
 *    recovered CAPTURE is counted (idempotently) if the first call's count rolled back.
 *  - INTAKE IS CAPTURED VOLUME, NOT CREATED PAYMENTS. Public checkout lets anyone
 *    create a payment, so counting at create would let a stranger fill a merchant's
 *    caps or push its pricing band without paying. Create only checks the config
 *    exists, the single-payment bound (no counter) and, read-only, that the caps
 *    still have room. The counters move at capture, when the money has arrived.
 *  - Row locks (the cap counters) are taken inside the caller's transaction,
 *    after the merchant lock, in a fixed order: daily, then monthly.
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
}

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
   * Payment CAPTURE: the one place intake is counted. Runs before the rail is asked and rolls back with
   * the capture, so only a capture that commits is counted. A fresh capture past a cap is refused, and
   * nothing has moved yet. A recovery (the ledger already holds the capture, the projection did not
   * commit) is never refused but IS counted, once, because its first count rolled back with it.
   */
  async function admitCapture(ctx: PaymentAdmitContext): Promise<void> {
    if (ctx.replay.kind === 'replay') return;
    const recovery = ctx.replay.kind === 'recovery';
    const { tx } = ctx;
    const { assetCode, amount } = readPaymentPayload(ctx.payload);
    const eventKey = `payment.capture:${ctx.paymentId.toLowerCase()}`;
    // Already counted by an earlier call (two racing first calls both read `fresh`): done.
    if (await alreadyCounted(tx, eventKey, 'daily_intake')) return;

    const control = await loadMerchantControl(tx, ctx.merchantId);
    let perPayment = 0n;
    let daily = 0n;
    let monthly = 0n;
    let resolved: ResolvedRule | null = null;
    try {
      requireTier(control);
      ({ perPayment, daily, monthly } = intakeLimits(control, assetCode));
      resolved = await requireRule(tx, control, ctx.merchantId, assetCode);
    } catch (error) {
      // Config removed since the payment was admitted: finishing a recovery is never refused.
      if (!(recovery && error instanceof ControlRefusal && error.kind === 'refused')) throw error;
    }
    const enforce = !recovery;
    if (enforce && amount > perPayment) throw new ControlRefusal('pay.cap_per_payment_exceeded');

    const at = now();
    const dailyResult = await consumeMoney(tx, {
      merchantId: ctx.merchantId,
      kind: 'daily_intake',
      assetCode,
      periodKey: dayKey(at),
      eventKey,
      amount,
      limit: daily,
      enforce,
    });
    const monthlyResult = await consumeMoney(tx, {
      merchantId: ctx.merchantId,
      kind: 'monthly_intake',
      assetCode,
      periodKey: monthKey(at),
      eventKey,
      amount,
      limit: monthly,
      enforce,
    });
    if (!resolved || (!dailyResult.counted && !monthlyResult.counted)) return;

    const rule = resolved;
    const quote = wrapConfig(() => computePricing(rule.rule, { amount, monthlyVolumeBefore: monthlyResult.usedBefore }));
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
  }

  return {
    async beforePaymentAdmit(ctx) {
      // Authorize moves nothing and is halts' business only.
      if (ctx.kind === 'payment.authorize') return;
      if (ctx.kind === 'payment.create') return admitCreate(ctx);
      return admitCapture(ctx);
    },

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
        eventKey: `payout:${ctx.settlementId.toLowerCase()}`,
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
     * A merchant's net is credited to the OWNER's user-money account, and
     * `withdrawal.create` debits that same account. Without this hook an owner could move
     * settled funds out through a withdrawal and skip every payout control. So a
     * withdrawal by a merchant owner is held to the same daily payout cap, beneficiary cap
     * and approval threshold of each merchant the user owns. (Funds in the account cannot
     * be told apart by origin, so every owned merchant's limits apply.)
     *
     * An amount at or above the approval threshold is refused `pay.approval_required`: a
     * maker-checker approval is bound to a settlement, and a withdrawal has none, so there
     * is nothing to approve yet. Closed rather than open.
     *
     * Locks: the caller's registry runs the treasury advisory lock (W5) before this, and
     * here the counters are taken merchant by merchant in id order, daily then beneficiary,
     * the same order the payout admission uses within one merchant.
     */
    async beforeUserMoneyWithdrawal(ctx) {
      if (ctx.replay.kind !== 'fresh') return;
      const { tx } = ctx;
      const owned = await tx<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE user_id = ${ctx.userId} ORDER BY id`;
      if (owned.length === 0) return;
      const at = now();
      for (const { id } of owned) {
        const merchantId = id.toLowerCase();
        const control = await loadMerchantControl(tx, merchantId);
        const tier = requireTier(control);
        const caps = effectiveCaps(control) ?? [];
        const dailyPayout = moneyCapLimit(caps, 'daily_payout', ctx.assetId);
        const beneficiaries = countCapLimit(caps);
        if (dailyPayout === null || beneficiaries === null) throw new ControlRefusal('pay.caps_unconfigured');
        const approvalThreshold = tier.approvalThresholds.get(ctx.assetId);
        if (approvalThreshold === undefined) throw new ControlRefusal('pay.approval_threshold_unconfigured');
        if (ctx.amount >= approvalThreshold) throw new ControlRefusal('pay.approval_required');

        const eventKey = `withdrawal:${merchantId}:${ctx.userId.toLowerCase()}:${ctx.clientRef}`;
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
