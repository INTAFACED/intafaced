import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  merchantTierSummarySchema,
  type FounderControlAuditListInput,
  type FounderLimitRequestCloseResult,
  type MerchantControlProfile,
  type MerchantLimitIncreaseResult,
  type MerchantLimitOpen,
  type MerchantLimitWithdrawResult,
  type MerchantPricingHistory,
  type MerchantTierList,
  type PayCap,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { roleOnMerchant as lookupRoleOnMerchant, type ControlAccessPorts } from './access.js';
import { listControlAudit, readMerchantAudit, type MerchantAuditEvent } from './audit.js';
import { ApprovalService } from './approvals.js';
import { ChangeService } from './changes.js';
import { readUsage } from './counters.js';
import { reservedLivePayoutAmount } from './payout-daily-limit.js';
import { ControlError } from './errors.js';
import { RESERVE_NOT_ENFORCED } from './reserve.js';
import {
  closeLimitRequest,
  listPendingLimitRequests,
  readOpenLimitRequest,
  requestLimitIncrease,
  withdrawLimitRequest,
} from './limit-requests.js';
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
import type { MerchantRole } from '../merchant-ops/roles.js';
import { readMerchantReserve, type MerchantReserveView } from '../merchant-pay-dev-out/reserve-read.js';

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

  /** Founder read of `pay.control_audit` (control changes and `payment.captured_over_cap`). */
  listAudit(input: FounderControlAuditListInput) {
    return listControlAudit(this.sql, input);
  }

  /** Merchant-facing access: another merchant's id and a missing id are the same answer. */
  async assertCanView(principal: Principal, merchantId: string): Promise<void> {
    if (!principal?.userId || !(await this.access.canViewMerchant(principal, merchantId))) throw new ControlError('pay.merchant_not_found');
  }

  /** Owner, else an active team role, else null. Does not grant anything by itself. */
  roleOnMerchant(principal: Principal, merchantId: string): Promise<MerchantRole | null> {
    return lookupRoleOnMerchant(this.sql, principal, merchantId);
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
            ? { rollingReserveBps: reserve.bps, holdDays: reserve.holdDays, enforcement: RESERVE_NOT_ENFORCED }
            : { rollingReserveBps: null, holdDays: null }
          : null,
      version: (control.profile?.version ?? 0n).toString(),
      updatedAt: control.profile?.updatedAt ? control.profile.updatedAt.toISOString() : null,
    };
  }

  /** M-money-out-01: reserve rule and recorded (not withheld) amounts. Read only. */
  reserve(merchantId: string): Promise<MerchantReserveView> {
    return readMerchantReserve(this.sql, merchantId, this.now());
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
      const reserved = cap.kind === 'daily_payout' ? await reservedLivePayoutAmount(this.sql, merchantId, cap.assetCode, at) : 0n;
      const limit = parseAmount(cap.limit);
      const committed = used + reserved;
      rows.push({
        kind: cap.kind,
        assetCode: cap.assetCode,
        limit: cap.limit,
        used: fmt(used),
        remaining: fmt(limit > committed ? limit - committed : 0n),
        resetsAt: (daily ? nextDayStart(at) : nextMonthStart(at)).toISOString(),
      });
    }
    return { merchantId, tierId: control.tier?.id ?? null, asOf: at.toISOString(), rows };
  }

  // ── operator reads ────────────────────────────────────────────────────────

  async listTiers() {
    const rows = await this.sql<Array<Parameters<typeof toTier>[0] & { merchants: string; merchant_visible: boolean }>>`
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
        merchantVisible: row.merchant_visible,
        payoutFee: tier.payoutFee,
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

  /** Names, status and parent from the merchant row. Null when the id does not exist. */
  async merchantRecord(merchantId: string): Promise<{
    displayName: string | null;
    legalName: string | null;
    status: 'pending' | 'active' | 'suspended' | 'closed';
    kybStatus: string;
    parentMerchantId: string | null;
  } | null> {
    const rows = await this.sql<
      Array<{
        display_name: string | null;
        legal_name: string | null;
        status: string;
        kyb_status: string;
        parent_merchant_id: string | null;
      }>
    >`
      SELECT display_name, legal_name, status::text AS status, kyb_status::text AS kyb_status, parent_merchant_id
        FROM pay.merchants WHERE id = ${merchantId}
    `;
    const row = rows[0];
    if (!row) return null;
    const statuses = ['pending', 'active', 'suspended', 'closed'] as const;
    if (!(statuses as readonly string[]).includes(row.status))
      throw new ControlError('pay.control_invalid', 'merchant status is unreadable');
    return {
      displayName: row.display_name,
      legalName: row.legal_name,
      status: row.status as (typeof statuses)[number],
      kybStatus: row.kyb_status,
      parentMerchantId: row.parent_merchant_id,
    };
  }

  /**
   * The tier ladder this merchant may read: their own tier, plus any tier
   * flagged `merchant_visible`. Another merchant's unpublished tier is not
   * included. Founder thresholds, approval bars, TTL, the visibility flag and
   * merchant counts stay on `founderAdmin.control.tiers.list`. No visible tier
   * and no assignment is `not_configured`. An assigned id with no row is not
   * reported as current. More than 64 visible tiers refuses rather than
   * dropping the rest. 64 is a response bound, not a product limit.
   */
  async merchantTierList(merchantId: string): Promise<MerchantTierList> {
    const control = await loadMerchantControl(this.sql, merchantId);
    const assigned = control.profile?.tierId ?? null;
    const rows = await this.sql<Array<Parameters<typeof toTier>[0]>>`
      SELECT * FROM pay.control_tiers
       WHERE merchant_visible OR (${assigned}::text IS NOT NULL AND id = ${assigned})
       ORDER BY id
       LIMIT 65
    `;
    if (rows.length === 0) return { status: 'not_configured', ownTierId: null };
    if (rows.length > 64) throw new ControlError('pay.control_invalid', 'tier catalogue exceeds the response bound');
    const archetypes = ['psp', 'broker', 'gaming', 'standard'] as const;
    // Each tier's own processing fees: the live rules of the tier pricing layer. A tier with none publishes no fee.
    const feeRows = await this.sql<Array<Parameters<typeof toRule>[0]>>`
      SELECT * FROM pay.control_pricing_rules
       WHERE layer = 'tier' AND superseded_at IS NULL AND scope_id = ANY(${this.sql.array(rows.map((row) => row.id))}::text[])
       ORDER BY scope_id, asset_code
    `;
    const feesOf = (tierId: string) =>
      feeRows
        .filter((row) => row.scope_id === tierId)
        .map(toRule)
        .map((rule) => ({
          assetCode: rule.assetCode,
          bands: rule.bands.map((b) => ({ fromAmount: fmt(b.fromAmount), feeBps: b.feeBps, flatFee: b.flatFee === null ? null : fmt(b.flatFee) })),
          spreadBps: rule.spreadBps,
          roundingBeneficiary: rule.roundingBeneficiary,
          minFee: rule.minFee === null ? null : fmt(rule.minFee),
          maxFee: rule.maxFee === null ? null : fmt(rule.maxFee),
          version: rule.version.toString(),
        }));
    const tiers = rows.map((row) => {
      const tier = toTier(row);
      if (!(archetypes as readonly string[]).includes(tier.archetype)) {
        throw new ControlError('pay.control_invalid', 'tier archetype is unreadable');
      }
      const summary = merchantTierSummarySchema.safeParse({
        id: tier.id,
        name: tier.name,
        archetype: tier.archetype,
        caps: [...tier.caps],
        reserve: tier.reserve ? { rollingReserveBps: tier.reserve.bps, holdDays: tier.reserve.holdDays } : null,
        fees: feesOf(tier.id),
        payoutFee: tier.payoutFee,
        version: tier.version.toString(),
      });
      if (!summary.success) throw new ControlError('pay.control_invalid', 'tier is unreadable');
      return summary.data;
    });
    const ownTierId = assigned !== null && tiers.some((tier) => tier.id === assigned) ? assigned : null;
    return { status: 'configured', ownTierId, tiers };
  }

  /**
   * Pricing rules that apply to this merchant (global, their current tier, their own layer),
   * including superseded rows. Another merchant's layer is not included. No rows means
   * `not_configured`, not a made-up schedule.
   */
  async pricingHistory(merchantId: string, limit: number): Promise<MerchantPricingHistory> {
    const control = await loadMerchantControl(this.sql, merchantId);
    const tierId = control.profile?.tierId ?? '';
    const rows = await this.sql<Array<Parameters<typeof toRule>[0] & { created_at: Date; superseded_at: Date | null }>>`
      SELECT * FROM pay.control_pricing_rules
       WHERE (layer = 'global' AND scope_id = '')
          OR (layer = 'tier' AND scope_id = ${tierId} AND ${tierId} <> '')
          OR (layer = 'merchant' AND scope_id = ${merchantId})
       ORDER BY created_at DESC, version DESC
       LIMIT ${limit}
    `;
    if (rows.length === 0) return { status: 'not_configured', events: [] };
    return {
      status: 'configured',
      events: rows.map((row) => ({
        ...ruleToView(toRule(row), row.created_at),
        supersededAt: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
      })),
    };
  }

  async recentAudit(merchantId: string, limit: number): Promise<{ events: MerchantAuditEvent[]; truncated: boolean }> {
    return readMerchantAudit(this.sql, merchantId, limit);
  }

  async openLimitRequest(merchantId: string): Promise<MerchantLimitOpen> {
    const request = await readOpenLimitRequest(this.sql, merchantId);
    return request ? { status: 'pending', request } : { status: 'none' };
  }

  /** Stores the ask. Does not write caps onto the merchant profile. Refuses a suspended or closed merchant. */
  requestLimitIncrease(
    principal: Principal,
    input: { merchantId: string; requestId: string; caps: PayCap[]; reason: string },
  ): Promise<MerchantLimitIncreaseResult> {
    return requestLimitIncrease(this.sql, principal, input);
  }

  /** The merchant takes the ask back. Does not change caps. */
  withdrawLimitRequest(
    principal: Principal,
    input: { merchantId: string; requestId: string; reason: string },
  ): Promise<MerchantLimitWithdrawResult> {
    return withdrawLimitRequest(this.sql, principal, input);
  }

  /** Founder closes one ask. Does not change caps. */
  closeLimitRequest(founderUserId: string, input: { requestId: string; reason: string }): Promise<FounderLimitRequestCloseResult> {
    return closeLimitRequest(this.sql, founderUserId, input);
  }

  listPendingLimitRequests(input: { limit: number; cursor?: string }) {
    return listPendingLimitRequests(this.sql, input);
  }
}
