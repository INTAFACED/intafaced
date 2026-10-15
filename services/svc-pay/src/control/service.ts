import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import type { MerchantControlProfile, PayCap } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { ControlAccessPorts } from './access.js';
import { ApprovalService } from './approvals.js';
import { ChangeService } from './changes.js';
import { readUsage } from './counters.js';
import { ControlError } from './errors.js';
import { computePricing, PricingConfigError, resolvePricingRule, type PricingLayer, type PricingRule } from './pricing.js';
import type { PricingQuoteView } from './schemas.js';
import {
  dayKey,
  effectiveCaps,
  effectiveReserve,
  loadApplicableRules,
  loadMerchantControl,
  monthKey,
  monthlyIntake,
  nextDayStart,
  nextMonthStart,
  toRule,
  toTier,
} from './store.js';

const fmt = formatAmount;

function ruleToContract(rule: PricingRule) {
  return {
    layer: rule.layer,
    scopeId: rule.layer === 'global' ? null : rule.scopeId,
    assetCode: rule.assetCode,
    bands: rule.bands.map((b) => ({
      fromAmount: fmt(b.fromAmount),
      feeBps: b.feeBps,
      flatFee: b.flatFee === null ? null : fmt(b.flatFee),
    })),
    spreadBps: rule.spreadBps,
    roundingBeneficiary: rule.roundingBeneficiary,
  };
}

export function ruleToView(rule: PricingRule, createdAt: Date) {
  return {
    ...ruleToContract(rule),
    minFee: rule.minFee === null ? null : fmt(rule.minFee),
    maxFee: rule.maxFee === null ? null : fmt(rule.maxFee),
    ruleId: rule.id,
    version: rule.version.toString(),
    createdAt: createdAt.toISOString(),
  };
}

/** Everything the control room reads or does, behind one object `index.ts` builds once. */
export class ControlService {
  readonly approvals: ApprovalService;
  readonly changes: ChangeService;

  constructor(
    private readonly sql: Sql,
    readonly access: ControlAccessPorts,
    private readonly options: { now?: () => Date } = {},
  ) {
    this.approvals = new ApprovalService(sql, { access, ...(options.now ? { now: options.now } : {}) });
    this.changes = new ChangeService(sql, options.now ? { now: options.now } : {});
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /** Merchant-facing access: another merchant's id and a missing id are the same answer. */
  async assertCanView(principal: Principal, merchantId: string): Promise<void> {
    if (!principal?.userId || !(await this.access.canViewMerchant(principal, merchantId))) throw new ControlError('pay.merchant_not_found');
  }

  /** The contract profile: tier, effective caps, effective pricing, reserve. Null sections are unconfigured. */
  async profile(merchantId: string): Promise<MerchantControlProfile> {
    const control = await loadMerchantControl(this.sql, merchantId);
    const caps = effectiveCaps(control);
    const rules = await this.effectiveRules(merchantId, control.tier?.id ?? null);
    const reserve = effectiveReserve(control);
    return {
      merchantId,
      tierId: control.tier?.id ?? null,
      archetypeId: control.profile?.archetypeId ?? control.tier?.archetype ?? null,
      caps: caps as PayCap[] | null,
      pricing: rules.length === 0 ? null : rules.map(ruleToContract),
      reserve:
        control.tier || control.profile?.reserveOverride !== undefined
          ? reserve
            ? { rollingReserveBps: reserve.bps, holdDays: reserve.holdDays }
            : { rollingReserveBps: null, holdDays: null }
          : null,
      version: (control.profile?.version ?? 0n).toString(),
      updatedAt: control.profile?.updatedAt ? control.profile.updatedAt.toISOString() : null,
    };
  }

  /** One rule per asset: the most specific layer wins. */
  private async effectiveRules(merchantId: string, tierId: string | null): Promise<PricingRule[]> {
    const rows = await this.sql<Array<Parameters<typeof toRule>[0]>>`
      SELECT * FROM pay.control_pricing_rules
       WHERE superseded_at IS NULL
         AND ((layer = 'global' AND scope_id = '') OR (layer = 'tier' AND scope_id = ${tierId ?? ''}) OR (layer = 'merchant' AND scope_id = ${merchantId}))
    `;
    const rules = rows.map(toRule);
    const out: PricingRule[] = [];
    for (const asset of [...new Set(rules.map((r) => r.assetCode))].sort()) {
      const resolved = resolvePricingRule(rules, asset);
      if (resolved) out.push(resolved.rule);
    }
    return out;
  }

  /** Same engine as the live path; with no `monthlyVolume` it uses the merchant's real month to date. */
  async previewPricing(input: {
    merchantId: string;
    assetCode: string;
    amount: string;
    monthlyVolume?: string;
    conversion?: boolean;
  }): Promise<PricingQuoteView> {
    const control = await loadMerchantControl(this.sql, input.merchantId);
    const resolved = resolvePricingRule(
      await loadApplicableRules(this.sql, input.merchantId, control.tier?.id ?? null, input.assetCode),
      input.assetCode,
    );
    if (!resolved) throw new ControlError('pay.pricing_unconfigured');
    const at = this.now();
    const volume =
      input.monthlyVolume !== undefined
        ? parseAmount(input.monthlyVolume)
        : await monthlyIntake(this.sql, input.merchantId, input.assetCode, at);
    let quote;
    try {
      quote = computePricing(resolved.rule, {
        amount: parseAmount(input.amount),
        monthlyVolumeBefore: volume,
        ...(input.conversion ? { conversion: true } : {}),
      });
    } catch (error) {
      if (error instanceof PricingConfigError) throw new ControlError('pay.control_invalid', error.message);
      throw error;
    }
    return {
      ruleId: quote.ruleId,
      appliedLayer: quote.layer,
      ruleChain: resolved.chain.map((c) => ({ layer: c.layer, ruleId: c.ruleId, version: c.version })),
      monthlyVolumeBefore: fmt(volume),
      bandFrom: fmt(quote.bandFrom),
      feeBps: quote.feeBps,
      flatFee: quote.flatFee === null ? null : fmt(quote.flatFee),
      spreadBps: quote.spreadBps,
      roundingBeneficiary: quote.roundingBeneficiary,
      roundingMode: quote.roundingMode,
      bpsFee: fmt(quote.bpsFee),
      feeBeforeClamp: fmt(quote.feeBeforeClamp),
      fee: fmt(quote.fee),
      spread: quote.spread === null ? null : fmt(quote.spread),
      net: fmt(quote.net),
    };
  }

  /** Caps with usage and headroom. A cap nobody configured is simply absent from `rows`. */
  async usage(merchantId: string) {
    const control = await loadMerchantControl(this.sql, merchantId);
    const at = this.now();
    const caps = effectiveCaps(control) ?? [];
    const rows = [];
    for (const cap of caps) {
      if (cap.kind === 'beneficiaries_per_day') {
        const used = await readUsage(this.sql, merchantId, 'beneficiaries_per_day', '', dayKey(at));
        rows.push({
          kind: cap.kind,
          assetCode: null,
          limit: String(cap.limit),
          used: (used / 10n ** 18n).toString(),
          remaining: String(Math.max(0, cap.limit - Number(used / 10n ** 18n))),
          resetsAt: nextDayStart(at).toISOString(),
        });
        continue;
      }
      if (cap.kind === 'per_payment') {
        rows.push({ kind: cap.kind, assetCode: cap.assetCode, limit: cap.limit, used: null, remaining: null, resetsAt: null });
        continue;
      }
      const daily = cap.kind === 'daily_intake' || cap.kind === 'daily_payout';
      const used = await readUsage(this.sql, merchantId, cap.kind, cap.assetCode, daily ? dayKey(at) : monthKey(at));
      const limit = parseAmount(cap.limit);
      rows.push({
        kind: cap.kind,
        assetCode: cap.assetCode,
        limit: cap.limit,
        used: fmt(used),
        remaining: fmt(limit > used ? limit - used : 0n),
        resetsAt: (daily ? nextDayStart(at) : nextMonthStart(at)).toISOString(),
      });
    }
    return { merchantId, tierId: control.tier?.id ?? null, asOf: at.toISOString(), rows };
  }

  // ── operator reads ────────────────────────────────────────────────────────

  async listTiers() {
    const rows = await this.sql<Array<Parameters<typeof toTier>[0] & { merchants: string }>>`
      SELECT t.*, (SELECT count(*) FROM pay.control_merchant_profiles p WHERE p.tier_id = t.id) AS merchants
        FROM pay.control_tiers t ORDER BY t.id
    `;
    return rows.map((row) => {
      const tier = toTier(row);
      return {
        id: tier.id,
        name: tier.name,
        archetype: tier.archetype as 'psp' | 'broker' | 'gaming' | 'standard',
        caps: [...tier.caps],
        reserve: tier.reserve ? { rollingReserveBps: tier.reserve.bps, holdDays: tier.reserve.holdDays } : null,
        approvalThresholds: [...tier.approvalThresholds].map(([assetCode, amount]) => ({ assetCode, amount: fmt(amount) })),
        founderThresholds: [...tier.founderThresholds].map(([assetCode, amount]) => ({ assetCode, amount: fmt(amount) })),
        approvalTtlSeconds: tier.approvalTtlSeconds,
        version: tier.version.toString(),
        merchants: Number(row.merchants),
      };
    });
  }

  async listRules(filter: { layer?: PricingLayer; scopeId?: string }) {
    const rows = await this.sql<Array<Parameters<typeof toRule>[0] & { created_at: Date }>>`
      SELECT * FROM pay.control_pricing_rules
       WHERE superseded_at IS NULL
         AND (${filter.layer ?? null}::text IS NULL OR layer = ${filter.layer ?? null})
         AND (${filter.scopeId ?? null}::text IS NULL OR scope_id = ${filter.scopeId ?? null})
       ORDER BY layer, scope_id, asset_code
    `;
    return rows.map((row) => ruleToView(toRule(row), row.created_at));
  }
}
