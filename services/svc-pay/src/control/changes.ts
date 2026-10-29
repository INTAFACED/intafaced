import type { Sql } from 'postgres';
import { z } from 'zod';
import type { FounderPendingChange, FounderPendingChangeListInput, MerchantControlChange, PayCap } from '@intafaced/contracts';
import { changeHashesEqual, founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { DualControlError, requireDualControl } from '../dual-control.js';
import { writeAudit } from './audit.js';
import { ControlError } from './errors.js';
import { assertReserveMayBeConfigured } from './reserve.js';
import { closePendingForCapChange, closePendingForTierChange } from './limit-requests.js';
import { assertValidRule, PricingConfigError, type PricingBand, type PricingRule } from './pricing.js';
import { pricingRuleBodySchema, tierDefinitionSchema, type PricingRuleBody, type TierDefinitionInput } from './schemas.js';
import { toRule } from './store.js';

/**
 * DUAL-CONTROL CONFIGURATION CHANGES.
 *
 * Tier assignment, caps, pricing rules, reserve and tier definitions are changed
 * in two steps by two DIFFERENT founders, each on their own authenticated live
 * session (`founderProcedure`): `submit` records the change as pending and
 * nothing takes effect; `confirm` by another founder validates it again against
 * the current version and applies it. Every attempt, including refused and
 * conflicting ones, leaves an audit row with the actor(s). Versions are
 * optimistic: a stale `expectedVersion` is a `conflict`, not an overwrite.
 *
 * Nothing here has a default number: a rule or tier is exactly what the founders
 * typed, validated, or it is refused.
 */

export type ChangeTarget =
  | { readonly scope: 'merchant'; readonly merchantId: string; readonly change: MerchantControlChange }
  | { readonly scope: 'tier'; readonly change: { readonly kind: 'upsert_tier'; readonly tier: TierDefinitionInput } }
  | {
      readonly scope: 'pricing';
      readonly change: {
        readonly kind: 'set_pricing_layer';
        readonly layer: 'global' | 'tier' | 'merchant';
        readonly scopeId: string | null;
        readonly rules: readonly PricingRuleBody[];
      };
    };

export type ChangeOutcomeKind = 'changed' | 'noop' | 'refused' | 'conflict' | 'pending_second_approval';

export interface ChangeOutcome {
  readonly requestId: string;
  readonly scope: 'merchant' | 'tier' | 'pricing';
  readonly scopeId: string;
  readonly merchantId: string | null;
  readonly outcome: ChangeOutcomeKind;
  readonly actorUserId: string;
  readonly version: bigint;
  readonly occurredAt: Date;
}

interface Plan {
  readonly scopeId: string;
  readonly merchantId: string | null;
  readonly version: bigint;
  readonly before: unknown;
  readonly after: unknown;
  readonly noop: boolean;
  readonly apply: (tx: Sql) => Promise<void>;
}

class Refused extends Error {}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
/** The canonical hash is shared with the admin BFF through `@intafaced/contracts/founder-change-hash`: one definition. */
const sha = (value: { target: ChangeTarget; expectedVersion: string }): string => founderChangeHash(value.target, value.expectedVersion);

const capKey = (cap: PayCap): string => (cap.kind === 'beneficiaries_per_day' ? cap.kind : `${cap.kind}:${cap.assetCode}`);

function assertCaps(caps: readonly PayCap[]): PayCap[] {
  const seen = new Set<string>();
  for (const cap of caps) {
    const key = capKey(cap);
    if (seen.has(key)) throw new Refused(`duplicate cap ${key}`);
    seen.add(key);
    if (cap.kind !== 'beneficiaries_per_day') {
      try {
        parseAmount(cap.limit);
      } catch {
        throw new Refused(`cap ${key} has an invalid limit`);
      }
    }
  }
  return [...caps].sort((a, b) => capKey(a).localeCompare(capKey(b)));
}

function toPricingRule(input: PricingRuleBody, layer: PricingRule['layer'], scopeId: string): PricingRule {
  const bands: PricingBand[] = input.bands.map((b) => ({
    fromAmount: parseAmount(b.fromAmount),
    feeBps: b.feeBps,
    flatFee: b.flatFee === null ? null : parseAmount(b.flatFee),
  }));
  const rule: PricingRule = {
    id: '00000000-0000-0000-0000-000000000000',
    layer,
    scopeId,
    assetCode: input.assetCode,
    bands,
    spreadBps: input.spreadBps,
    roundingBeneficiary: input.roundingBeneficiary,
    minFee: input.minFee == null ? null : parseAmount(input.minFee),
    maxFee: input.maxFee == null ? null : parseAmount(input.maxFee),
    version: 0n,
  };
  try {
    assertValidRule(rule);
  } catch (error) {
    if (error instanceof PricingConfigError) throw new Refused(error.message);
    throw error;
  }
  return rule;
}

const canonicalRule = (rule: PricingRule) => ({
  assetCode: rule.assetCode,
  bands: rule.bands.map((b) => ({
    fromAmount: formatAmount(b.fromAmount),
    feeBps: b.feeBps,
    flatFee: b.flatFee === null ? null : formatAmount(b.flatFee),
  })),
  spreadBps: rule.spreadBps,
  roundingBeneficiary: rule.roundingBeneficiary,
  minFee: rule.minFee === null ? null : formatAmount(rule.minFee),
  maxFee: rule.maxFee === null ? null : formatAmount(rule.maxFee),
});

const thresholdJson = (rows: ReadonlyArray<{ assetCode: string; amount: string }>) =>
  [...rows]
    .map((r) => ({ assetCode: r.assetCode, amount: formatAmount(parseAmount(r.amount)) }))
    .sort((a, b) => a.assetCode.localeCompare(b.assetCode));

export class ChangeService {
  constructor(
    private readonly sql: Sql,
    private readonly options: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  // ── planning ──────────────────────────────────────────────────────────────

  private async pricingVersion(tx: Sql, layer: string, scopeId: string): Promise<bigint> {
    if (layer === 'merchant') {
      const rows = await tx<Array<{ version: string }>>`SELECT version FROM pay.control_merchant_profiles WHERE merchant_id = ${scopeId}`;
      return BigInt(rows[0]?.version ?? '0');
    }
    const rows = await tx<
      Array<{ v: string }>
    >`SELECT COALESCE(max(version), 0) AS v FROM pay.control_pricing_rules WHERE layer = ${layer} AND scope_id = ${scopeId}`;
    return BigInt(rows[0]!.v);
  }

  private async plan(tx: Sql, target: ChangeTarget, actor: string): Promise<Plan> {
    if (target.scope === 'merchant') return this.planMerchant(tx, target, actor);
    if (target.scope === 'tier') return this.planTier(tx, target.change.tier, actor);
    return this.planPricing(tx, target.change, actor);
  }

  private async planMerchant(tx: Sql, target: Extract<ChangeTarget, { scope: 'merchant' }>, actor: string): Promise<Plan> {
    const { merchantId, change } = target;
    const merchant = await tx`SELECT 1 FROM pay.merchants WHERE id = ${merchantId}`;
    if (merchant.length === 0) throw new Refused('merchant not found');
    const rows = await tx<
      Array<{ tier_id: string | null; archetype_id: string | null; caps_override: unknown; reserve_override: unknown; version: string }>
    >`
      SELECT tier_id, archetype_id, caps_override, reserve_override, version FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantId}
    `;
    const cur = rows[0];
    const version = BigInt(cur?.version ?? '0');
    const ensure = async (q: Sql) => {
      await q`INSERT INTO pay.control_merchant_profiles (merchant_id) VALUES (${merchantId}) ON CONFLICT DO NOTHING`;
      await q`SELECT 1 FROM pay.control_merchant_profiles WHERE merchant_id = ${merchantId} FOR UPDATE`;
    };
    const bump = (q: Sql) =>
      q`UPDATE pay.control_merchant_profiles SET version = version + 1, updated_by = ${actor}, updated_at = now() WHERE merchant_id = ${merchantId}`;

    if (change.kind === 'set_tier') {
      const tier = await tx`SELECT 1 FROM pay.control_tiers WHERE id = ${change.tierId}`;
      if (tier.length === 0) throw new Refused('tier not found');
      const before = { tierId: cur?.tier_id ?? null, archetypeId: cur?.archetype_id ?? null };
      const after = { tierId: change.tierId, archetypeId: change.archetypeId };
      if (change.archetypeId !== null && !['psp', 'broker', 'gaming', 'standard'].includes(change.archetypeId))
        throw new Refused('unknown archetype');
      return {
        scopeId: merchantId,
        merchantId,
        version,
        before,
        after,
        noop: stable(before) === stable(after),
        apply: async (q) => {
          await ensure(q);
          await q`UPDATE pay.control_merchant_profiles SET tier_id = ${change.tierId}, archetype_id = ${change.archetypeId} WHERE merchant_id = ${merchantId}`;
          await bump(q);
        },
      };
    }
    if (change.kind === 'set_caps') {
      // A merchant's caps sit on top of its tier's caps. With no tier nothing would take effect (and payments refuse), so a change that
      // "succeeds" would be a lie: say so instead, at submit and again at confirm.
      if (!cur?.tier_id) throw new ControlError('pay.tier_unassigned', 'assign a tier first: caps override a tier’s caps');
      const caps = assertCaps(change.caps);
      const before = cur?.caps_override ?? null;
      return {
        scopeId: merchantId,
        merchantId,
        version,
        before,
        after: caps,
        noop: before !== null && stable(before) === stable(caps),
        apply: async (q) => {
          await ensure(q);
          await q`UPDATE pay.control_merchant_profiles SET caps_override = ${q.json(caps as never)} WHERE merchant_id = ${merchantId}`;
          await bump(q);
        },
      };
    }
    if (change.kind === 'set_reserve') {
      const { rollingReserveBps, holdDays } = change.reserve;
      if ((rollingReserveBps === null) !== (holdDays === null))
        throw new Refused('a reserve needs both a percentage and a hold period, or neither');
      // Fail closed: a percentage would be shown as held, and nothing books it.
      // Thrown (not Refused) so the transaction rolls back and no change row is written.
      assertReserveMayBeConfigured(change.reserve);
      const before = cur?.reserve_override ?? null;
      const after = { rollingReserveBps, holdDays };
      return {
        scopeId: merchantId,
        merchantId,
        version,
        before,
        after,
        noop: before !== null && stable(before) === stable(after),
        apply: async (q) => {
          await ensure(q);
          await q`UPDATE pay.control_merchant_profiles SET reserve_override = ${q.json(after as never)} WHERE merchant_id = ${merchantId}`;
          await bump(q);
        },
      };
    }
    // set_pricing (contract kind): merchant-layer rules only.
    for (const rule of change.pricing) {
      if (rule.layer !== 'merchant' || rule.scopeId !== merchantId)
        throw new Refused('a merchant pricing change may only set rules for that merchant');
    }
    return this.planRules(tx, 'merchant', merchantId, change.pricing as PricingRuleBody[], actor, merchantId);
  }

  private async planRules(
    tx: Sql,
    layer: 'global' | 'tier' | 'merchant',
    scopeId: string,
    inputs: readonly PricingRuleBody[],
    actor: string,
    merchantId: string | null,
  ): Promise<Plan> {
    const dbScope = layer === 'global' ? '' : scopeId;
    const rules = inputs.map((r) => toPricingRule(r, layer, dbScope));
    const assets = new Set<string>();
    for (const rule of rules) {
      if (assets.has(rule.assetCode)) throw new Refused(`two rules for ${rule.assetCode}`);
      assets.add(rule.assetCode);
    }
    if (layer === 'tier') {
      const tier = await tx`SELECT 1 FROM pay.control_tiers WHERE id = ${scopeId}`;
      if (tier.length === 0) throw new Refused('tier not found');
    }
    if (layer === 'merchant') {
      const merchant = await tx`SELECT 1 FROM pay.merchants WHERE id = ${scopeId}`;
      if (merchant.length === 0) throw new Refused('merchant not found');
    }
    const live = await tx<Array<Parameters<typeof toRule>[0]>>`
      SELECT * FROM pay.control_pricing_rules WHERE layer = ${layer} AND scope_id = ${dbScope} AND superseded_at IS NULL
    `;
    const liveRules = live.map(toRule);
    const before = liveRules
      .filter((r) => assets.has(r.assetCode))
      .map(canonicalRule)
      .sort((a, b) => a.assetCode.localeCompare(b.assetCode));
    const after = rules.map(canonicalRule).sort((a, b) => a.assetCode.localeCompare(b.assetCode));
    const version = await this.pricingVersion(tx, layer, dbScope);
    return {
      scopeId: layer === 'global' ? 'global' : scopeId,
      merchantId,
      version,
      before,
      after,
      noop: stable(before) === stable(after),
      apply: async (q) => {
        if (layer === 'merchant') {
          await q`INSERT INTO pay.control_merchant_profiles (merchant_id) VALUES (${scopeId}) ON CONFLICT DO NOTHING`;
          await q`SELECT 1 FROM pay.control_merchant_profiles WHERE merchant_id = ${scopeId} FOR UPDATE`;
          await q`UPDATE pay.control_merchant_profiles SET version = version + 1, updated_by = ${actor}, updated_at = now() WHERE merchant_id = ${scopeId}`;
        }
        const next = (await this.pricingVersion(q, layer, dbScope)) + 1n;
        for (const rule of rules) {
          await q`
            UPDATE pay.control_pricing_rules SET superseded_at = now()
             WHERE layer = ${layer} AND scope_id = ${dbScope} AND asset_code = ${rule.assetCode} AND superseded_at IS NULL
          `;
          await q`
            INSERT INTO pay.control_pricing_rules (layer, scope_id, asset_code, bands, spread_bps, rounding_beneficiary, min_fee, max_fee, version, created_by)
            VALUES (${layer}, ${dbScope}, ${rule.assetCode}, ${q.json(canonicalRule(rule).bands as never)}, ${rule.spreadBps}, ${rule.roundingBeneficiary},
                    ${rule.minFee === null ? null : formatAmount(rule.minFee)}::numeric, ${rule.maxFee === null ? null : formatAmount(rule.maxFee)}::numeric,
                    ${next.toString()}, ${actor})
          `;
        }
      },
    };
  }

  private async planPricing(tx: Sql, change: Extract<ChangeTarget, { scope: 'pricing' }>['change'], actor: string): Promise<Plan> {
    if (change.layer === 'global' && change.scopeId !== null) throw new Refused('the global layer has no scope id');
    if (change.layer !== 'global' && !change.scopeId) throw new Refused('this layer needs a scope id');
    return this.planRules(tx, change.layer, change.scopeId ?? '', change.rules, actor, change.layer === 'merchant' ? change.scopeId : null);
  }

  private async planTier(tx: Sql, tier: TierDefinitionInput, actor: string): Promise<Plan> {
    const caps = assertCaps(tier.caps);
    const approval = thresholdJson(tier.approvalThresholds);
    const founder = thresholdJson(tier.founderThresholds);
    for (const list of [approval, founder]) {
      if (new Set(list.map((r) => r.assetCode)).size !== list.length) throw new Refused('duplicate threshold asset');
    }
    // A payout needing founders must also need the merchant's own checker first.
    for (const f of founder) {
      const a = approval.find((x) => x.assetCode === f.assetCode);
      if (!a) throw new Refused(`founder threshold for ${f.assetCode} needs an approval threshold`);
      if (parseAmount(f.amount) < parseAmount(a.amount))
        throw new Refused(`founder threshold for ${f.assetCode} is below the approval threshold`);
    }
    if (tier.reserve && (tier.reserve.rollingReserveBps === null) !== (tier.reserve.holdDays === null)) {
      throw new Refused('a reserve needs both a percentage and a hold period, or neither');
    }
    const rows = await tx<
      Array<{
        version: string;
        caps: unknown;
        name: string;
        archetype: string;
        reserve_bps: number | null;
        reserve_hold_days: number | null;
        approval_thresholds: unknown;
        founder_thresholds: unknown;
        approval_ttl_seconds: number;
        merchant_visible: boolean;
        payout_fee: unknown;
      }>
    >`
      SELECT * FROM pay.control_tiers WHERE id = ${tier.id}
    `;
    const cur = rows[0];
    const reserve =
      tier.reserve && tier.reserve.rollingReserveBps !== null
        ? { bps: tier.reserve.rollingReserveBps, holdDays: tier.reserve.holdDays }
        : null;
    const merchantVisible = tier.merchantVisible === true;
    // Omitted keeps what the tier publishes (nothing, for a new tier), so a change to other terms never drops a published
    // payout fee unseen; only an explicit null withdraws it. In the plan, so a change of only the payout fee is not a noop.
    const payoutFee = tier.payoutFee === undefined ? (cur?.payout_fee ?? null) : tier.payoutFee;
    const after = {
      name: tier.name,
      archetype: tier.archetype,
      caps,
      reserve,
      approvalThresholds: approval,
      founderThresholds: founder,
      approvalTtlSeconds: tier.approvalTtlSeconds,
      merchantVisible,
      payoutFee,
    };
    const before = cur
      ? {
          name: cur.name,
          archetype: cur.archetype,
          caps: cur.caps,
          reserve: cur.reserve_bps === null ? null : { bps: cur.reserve_bps, holdDays: cur.reserve_hold_days },
          approvalThresholds: cur.approval_thresholds,
          founderThresholds: cur.founder_thresholds,
          approvalTtlSeconds: cur.approval_ttl_seconds,
          merchantVisible: cur.merchant_visible,
          payoutFee: cur.payout_fee ?? null,
        }
      : null;
    const version = BigInt(cur?.version ?? '0');
    return {
      scopeId: tier.id,
      merchantId: null,
      version,
      before,
      after,
      noop: before !== null && stable(before) === stable(after),
      apply: async (q) => {
        if (cur) {
          await q`SELECT 1 FROM pay.control_tiers WHERE id = ${tier.id} FOR UPDATE`;
          await q`
            UPDATE pay.control_tiers SET name = ${tier.name}, archetype = ${tier.archetype}, caps = ${q.json(caps as never)},
                   reserve_bps = ${reserve?.bps ?? null}, reserve_hold_days = ${reserve?.holdDays ?? null},
                   approval_thresholds = ${q.json(approval as never)}, founder_thresholds = ${q.json(founder as never)},
                   approval_ttl_seconds = ${tier.approvalTtlSeconds}, merchant_visible = ${merchantVisible},
                   payout_fee = ${payoutFee === null ? null : q.json(payoutFee as never)},
                   version = version + 1, updated_by = ${actor}, updated_at = now()
             WHERE id = ${tier.id}
          `;
        } else {
          await q`
            INSERT INTO pay.control_tiers (id, name, archetype, caps, reserve_bps, reserve_hold_days, approval_thresholds, founder_thresholds, approval_ttl_seconds, merchant_visible, payout_fee, updated_by)
            VALUES (${tier.id}, ${tier.name}, ${tier.archetype}, ${q.json(caps as never)}, ${reserve?.bps ?? null}, ${reserve?.holdDays ?? null},
                    ${q.json(approval as never)}, ${q.json(founder as never)}, ${tier.approvalTtlSeconds}, ${merchantVisible},
                    ${payoutFee === null ? null : q.json(payoutFee as never)}, ${actor})
          `;
        }
      },
    };
  }

  // ── submit / confirm ──────────────────────────────────────────────────────

  private result(
    row: { request_id: string; scope: ChangeOutcome['scope']; scope_id: string; merchant_id: string | null; expected_version: string },
    outcome: ChangeOutcomeKind,
    actor: string,
    version: bigint,
    at: Date,
  ): ChangeOutcome {
    return {
      requestId: row.request_id,
      scope: row.scope,
      scopeId: row.scope_id,
      merchantId: row.merchant_id,
      outcome,
      actorUserId: actor,
      version,
      occurredAt: at,
    };
  }

  private scopeOf(target: ChangeTarget): { scope: ChangeOutcome['scope']; scopeId: string; merchantId: string | null } {
    if (target.scope === 'merchant') return { scope: 'merchant', scopeId: target.merchantId, merchantId: target.merchantId };
    if (target.scope === 'tier') return { scope: 'tier', scopeId: target.change.tier.id, merchantId: null };
    const { layer, scopeId } = target.change;
    return {
      scope: 'pricing',
      scopeId: layer === 'global' ? 'global' : `${layer}:${scopeId ?? ''}`,
      merchantId: layer === 'merchant' ? scopeId : null,
    };
  }

  /** The scope a stored change belongs to, or null when there is no such request. */
  async scopeOfRequest(requestId: string): Promise<ChangeOutcome['scope'] | null> {
    const rows = await this.sql<
      Array<{ scope: ChangeOutcome['scope'] }>
    >`SELECT scope FROM pay.control_changes WHERE request_id = ${requestId}`;
    return rows[0]?.scope ?? null;
  }

  /** First founder: record the change as pending. Nothing takes effect. */
  async submit(
    founderUserId: string,
    input: { requestId: string; target: ChangeTarget; reason: string; expectedVersion: string },
  ): Promise<ChangeOutcome> {
    const at = this.now();
    const place = this.scopeOf(input.target);
    const hash = sha({ target: input.target, expectedVersion: input.expectedVersion });
    return transaction(
      this.sql,
      async (tx) => {
        const prior = await tx<
          Array<{
            request_id: string;
            scope: ChangeOutcome['scope'];
            scope_id: string;
            merchant_id: string | null;
            expected_version: string;
            change_hash: string;
            status: string;
            maker_id: string;
          }>
        >`
          SELECT request_id, scope, scope_id, merchant_id, expected_version, change_hash, status, maker_id FROM pay.control_changes WHERE request_id = ${input.requestId}
        `;
        if (prior[0]) {
          if (prior[0].change_hash !== hash || prior[0].maker_id !== founderUserId) throw new ControlError('pay.request_id_reused');
          const map: Record<string, ChangeOutcomeKind> = {
            pending: 'pending_second_approval',
            applied: 'changed',
            rejected: 'refused',
            conflict: 'conflict',
          };
          return this.result(prior[0], map[prior[0].status] ?? 'refused', founderUserId, BigInt(prior[0].expected_version), at);
        }
        const expected = BigInt(input.expectedVersion);
        let outcome: ChangeOutcomeKind;
        let version = expected;
        let before: unknown;
        let after: unknown;
        try {
          const plan = await this.plan(tx, input.target, founderUserId);
          version = plan.version;
          before = plan.before;
          after = plan.after;
          outcome = plan.version !== expected ? 'conflict' : plan.noop ? 'noop' : 'pending_second_approval';
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          outcome = 'refused';
          after = { refusedBecause: error.message };
        }
        await writeAudit(tx, {
          scope: place.scope,
          scopeId: place.scopeId,
          merchantId: place.merchantId,
          kind: 'control.change_submitted',
          outcome,
          actorId: founderUserId,
          requestId: input.requestId,
          reason: input.reason,
          before,
          after,
        });
        if (outcome === 'pending_second_approval') {
          await tx`
            INSERT INTO pay.control_changes (request_id, scope, scope_id, merchant_id, change, change_hash, reason, expected_version, maker_id)
            VALUES (${input.requestId}, ${place.scope}, ${place.scopeId}, ${place.merchantId}, ${tx.json(input.target as never)}, ${hash},
                    ${input.reason}, ${input.expectedVersion}, ${founderUserId})
          `;
        }
        return { requestId: input.requestId, ...place, outcome, actorUserId: founderUserId, version, occurredAt: at };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** Second founder: confirm (applies) or reject. The same founder, or a typed-in name, cannot. */
  async confirm(
    founderUserId: string,
    input: { requestId: string; decision: 'confirm' | 'reject'; reason: string; expectedChangeHash: string },
  ): Promise<ChangeOutcome> {
    const at = this.now();
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<
          Array<{
            request_id: string;
            scope: ChangeOutcome['scope'];
            scope_id: string;
            merchant_id: string | null;
            change: unknown;
            expected_version: string;
            maker_id: string;
            checker_id: string | null;
            status: string;
            reason: string;
            change_hash: string;
          }>
        >`
          SELECT request_id, scope, scope_id, merchant_id, change, expected_version, maker_id, checker_id, status, reason, change_hash
            FROM pay.control_changes WHERE request_id = ${input.requestId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new ControlError('pay.change_not_found');
        // Before ANYTHING else (a repeat, a decline, an apply): the confirmer must have been shown exactly the change on file.
        if (!changeHashesEqual(row.change_hash, input.expectedChangeHash)) throw new ControlError('pay.change_hash_mismatch');
        if (row.status === 'applied' && row.checker_id === founderUserId && input.decision === 'confirm') {
          return this.result(row, 'changed', founderUserId, BigInt(row.expected_version) + 1n, at);
        }
        if (row.status !== 'pending') throw new ControlError('pay.change_not_pending');
        try {
          requireDualControl(row.maker_id, founderUserId);
        } catch (error) {
          if (error instanceof DualControlError) throw new ControlError('pay.dual_control_required', error.message);
          throw error;
        }
        if (input.decision === 'reject') {
          await tx`UPDATE pay.control_changes SET status = 'rejected', checker_id = ${founderUserId}, checker_reason = ${input.reason}, decided_at = now() WHERE request_id = ${row.request_id}`;
          await writeAudit(tx, {
            scope: row.scope,
            scopeId: row.scope_id,
            merchantId: row.merchant_id,
            kind: 'control.change_decided',
            outcome: 'rejected',
            actorId: row.maker_id,
            secondActorId: founderUserId,
            requestId: row.request_id,
            reason: input.reason,
          });
          return this.result(row, 'refused', founderUserId, BigInt(row.expected_version), at);
        }
        const target = this.revive(row.change);
        // One writer per scope from here to the commit, so the version check below cannot go stale.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${this.lockKey(target)}))`;
        const expected = BigInt(row.expected_version);
        let plan: Plan | null = null;
        let refusedBecause: string | null = null;
        try {
          plan = await this.plan(tx, target, founderUserId);
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          refusedBecause = error.message;
        }
        if (!plan || plan.version !== expected) {
          await tx`UPDATE pay.control_changes SET status = 'conflict', checker_id = ${founderUserId}, checker_reason = ${input.reason}, decided_at = now() WHERE request_id = ${row.request_id}`;
          await writeAudit(tx, {
            scope: row.scope,
            scopeId: row.scope_id,
            merchantId: row.merchant_id,
            kind: 'control.change_decided',
            outcome: 'conflict',
            actorId: row.maker_id,
            secondActorId: founderUserId,
            requestId: row.request_id,
            reason: input.reason,
            after: refusedBecause
              ? { refusedBecause }
              : { expectedVersion: row.expected_version, currentVersion: plan?.version.toString() },
          });
          return this.result(row, 'conflict', founderUserId, plan?.version ?? expected, at);
        }
        await plan.apply(tx);
        if (target.scope === 'merchant' && target.change.kind === 'set_caps') {
          await closePendingForCapChange(tx, target.merchantId, founderUserId, row.request_id);
        }
        if (target.scope === 'merchant' && target.change.kind === 'set_tier') {
          await closePendingForTierChange(tx, target.merchantId, founderUserId, row.request_id);
        }
        await tx`UPDATE pay.control_changes SET status = 'applied', checker_id = ${founderUserId}, checker_reason = ${input.reason}, decided_at = now() WHERE request_id = ${row.request_id}`;
        await writeAudit(tx, {
          scope: row.scope,
          scopeId: row.scope_id,
          merchantId: row.merchant_id,
          kind: 'control.change_decided',
          outcome: 'changed',
          actorId: row.maker_id,
          secondActorId: founderUserId,
          requestId: row.request_id,
          reason: row.reason,
          before: plan.before,
          after: plan.after,
        });
        return this.result(row, 'changed', founderUserId, plan.version + 1n, at);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * Control changes still waiting for a second founder, oldest first.
   * `changeHash` is what that founder sends as `expectedChangeHash`.
   */
  async listPending(input: FounderPendingChangeListInput): Promise<{ changes: FounderPendingChange[]; nextCursor: string | null }> {
    const cursor = input.cursor ?? null;
    const merchantId = input.merchantId ?? null;
    const scope = input.scope ?? null;
    const rows = await this.sql<
      Array<{
        request_id: string;
        seq: string | number | bigint;
        scope: FounderPendingChange['scope'];
        scope_id: string;
        merchant_id: string | null;
        change_body: unknown;
        change_hash: string;
        reason: string;
        expected_version: string | number | bigint;
        maker_id: string;
        created_at: Date | string;
      }>
    >`
      SELECT request_id, seq, scope, scope_id, merchant_id, change AS change_body, change_hash, reason, expected_version, maker_id, created_at
        FROM pay.control_changes
       WHERE status = 'pending'
         AND (${cursor}::bigint IS NULL OR seq > ${cursor}::bigint)
         AND (${merchantId}::uuid IS NULL OR merchant_id = ${merchantId}::uuid)
         AND (${scope}::text IS NULL OR scope = ${scope})
       ORDER BY seq ASC
       LIMIT ${input.limit + 1}
    `;
    const page = rows.slice(0, input.limit);
    return {
      changes: page.map((row) => ({
        requestId: row.request_id,
        seq: String(row.seq),
        scope: row.scope,
        scopeId: row.scope_id,
        merchantId: row.merchant_id,
        change: row.change_body,
        changeHash: row.change_hash,
        reason: row.reason,
        expectedVersion: String(row.expected_version),
        makerUserId: row.maker_id,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      })),
      nextCursor: rows.length > input.limit ? String(page[page.length - 1]!.seq) : null,
    };
  }

  private lockKey(target: ChangeTarget): string {
    if (target.scope === 'merchant') return `pay.control.merchant:${target.merchantId}`;
    if (target.scope === 'tier') return `pay.control.tier:${target.change.tier.id}`;
    const { layer, scopeId } = target.change;
    if (layer === 'merchant') return `pay.control.merchant:${scopeId ?? ''}`;
    return `pay.control.pricing:${layer}:${scopeId ?? ''}`;
  }

  /** Re-validate a stored change before it is applied: stored JSON is data, not trusted code. */
  private revive(value: unknown): ChangeTarget {
    const target = value as { scope?: string; merchantId?: string; change?: unknown };
    if (target?.scope === 'tier') {
      const parsed = z.object({ kind: z.literal('upsert_tier'), tier: tierDefinitionSchema }).parse(target.change);
      return { scope: 'tier', change: parsed };
    }
    if (target?.scope === 'pricing') {
      const parsed = z
        .object({
          kind: z.literal('set_pricing_layer'),
          layer: z.enum(['global', 'tier', 'merchant']),
          scopeId: z.string().nullable(),
          rules: z.array(pricingRuleBodySchema),
        })
        .parse(target.change);
      return { scope: 'pricing', change: parsed };
    }
    return value as ChangeTarget;
  }
}
