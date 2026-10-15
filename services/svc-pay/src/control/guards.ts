import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { PartialPayGuards } from '../seams/guards.js';
import { requirePayoutApproval } from './approval-gate.js';
import { alreadyCounted, consumeBeneficiary, consumeMoney } from './counters.js';
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
 *  - Counted ONCE per business key, in the admit hooks only
 *    (`payment.create:<paymentId>`, `payout:<settlementId>:<attempt>`).
 *  - A replay or a recovery is never refused and never counted.
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

export function createControlGuards(deps: ControlGuardDeps): PartialPayGuards {
  // Off = exactly today: no counters, no snapshots, no refusals.
  if (deps.mode === 'off') return {};
  const now = deps.now ?? (() => new Date());

  return {
    async beforePaymentAdmit(ctx) {
      // Intake is counted when a payment is created; authorize and capture are halts' business.
      if (ctx.kind !== 'payment.create') return;
      if (ctx.replay.kind !== 'fresh') return;

      const { tx } = ctx;
      const { assetCode, amount } = readPaymentPayload(ctx.payload);
      const eventKey = `payment.create:${ctx.paymentId.toLowerCase()}`;
      // Already counted by an earlier call (two racing first calls both read `fresh`): done.
      if (await alreadyCounted(tx, eventKey, 'daily_intake')) return;

      const control = await loadMerchantControl(tx, ctx.merchantId);
      requireTier(control);
      const caps = effectiveCaps(control) ?? [];
      const perPayment = moneyCapLimit(caps, 'per_payment', assetCode);
      const daily = moneyCapLimit(caps, 'daily_intake', assetCode);
      const monthly = moneyCapLimit(caps, 'monthly_intake', assetCode);
      if (perPayment === null || daily === null || monthly === null) throw new ControlRefusal('pay.caps_unconfigured');
      const resolved = await requireRule(tx, control, ctx.merchantId, assetCode);

      if (amount > perPayment) throw new ControlRefusal('pay.cap_per_payment_exceeded');

      const at = now();
      const dailyResult = await consumeMoney(tx, {
        merchantId: ctx.merchantId,
        kind: 'daily_intake',
        assetCode,
        periodKey: dayKey(at),
        eventKey,
        amount,
        limit: daily,
      });
      const monthlyResult = await consumeMoney(tx, {
        merchantId: ctx.merchantId,
        kind: 'monthly_intake',
        assetCode,
        periodKey: monthKey(at),
        eventKey,
        amount,
        limit: monthly,
      });
      if (!dailyResult.counted && !monthlyResult.counted) return;

      const quote = wrapConfig(() => computePricing(resolved.rule, { amount, monthlyVolumeBefore: monthlyResult.usedBefore }));
      await writePricingSnapshot(tx, {
        subjectKind: 'payment',
        subjectId: ctx.paymentId,
        merchantId: ctx.merchantId,
        assetCode,
        resolved,
        quote,
        baseAmount: amount,
        monthlyVolumeBefore: monthlyResult.usedBefore,
      });
    },

    async beforePayoutAdmit(ctx) {
      if (ctx.replay.kind !== 'fresh') return;
      const { tx } = ctx;
      const eventKey = `payout:${ctx.settlementId.toLowerCase()}:${ctx.attempt}`;
      if (await alreadyCounted(tx, eventKey, 'daily_payout')) return;

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

      await consumeMoney(tx, {
        merchantId: ctx.merchantId,
        kind: 'daily_payout',
        assetCode: ctx.assetId,
        periodKey: dayKey(at),
        eventKey,
        amount: ctx.amount,
        limit: dailyPayout,
      });
      await consumeBeneficiary(tx, {
        merchantId: ctx.merchantId,
        periodKey: dayKey(at),
        destination: `${ctx.destination.kind.trim().toLowerCase()}:${ctx.destination.ref.trim().toLowerCase()}`,
        eventKey,
        limit: beneficiaries,
      });
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
