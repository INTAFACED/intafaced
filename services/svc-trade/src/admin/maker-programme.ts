import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import {
  consumeApproval,
  loadRequest,
  payloadHash,
  requireClientRequestId,
  requireOperator,
  requireOperatorWrite,
  storeRequest,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';
import {
  checkMember,
  checkPlan,
  checkTerms,
  LAUNCH_PLAN_ACTION_TYPE,
  LAUNCH_PLAN_INVALID,
  LAUNCH_PLAN_MAKER_UNKNOWN,
  MAKER_MEMBER_ACTION_TYPE,
  MAKER_PROGRAMME_TERM_UNSET,
  MAKER_PROGRAMME_TIER_UNKNOWN,
  MAKER_TERMS_ACTION_TYPE,
  MAKER_TERMS_TARGET,
  memberApprovalBody,
  planApprovalBody,
  termsApprovalBody,
  type Checked,
  type MemberInput,
  type MemberStatus,
  type PlanInput,
  type TermsInput,
} from './maker-programme-model.js';

/**
 * The maker incentive programme (RC-cex-spot-06) and the launch-liquidity plan per market (RC-cex-spot-09), for
 * J-cex-spot-20 #8. Terms, members and plans are each a versioned two-person write: one operator files the request
 * bound to a hash of exactly the values and the version they follow, a second approves it, and the write consumes that
 * approval inside the transaction that inserts the version, its audit row and the request's answer. A blank refuses by
 * name before any approval is spent. A plan names only active programme members as its makers.
 *
 * Nothing here holds or moves value. Period measurement, settlement, incentive payment and clawback posting are a
 * later change; clawback records are read here and nothing writes them yet.
 */

function must<T>(checked: Checked<T>): T {
  if (!checked.ok) throw new TradeOpsError(checked.code, checked.message);
  return checked.value;
}

const trimDecimal = (v: string): string => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

export interface VersionStamp {
  readonly version: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly approvalId: string;
  readonly writtenAt: string;
}

export type TermsRow = TermsInput & VersionStamp;
export type MemberRow = MemberInput & VersionStamp & { readonly termsVersion: string };
export type PlanState = 'draft' | 'approved' | 'active' | 'exited';
export type PlanRow = PlanInput & VersionStamp & { readonly market: string; readonly symbol: string; readonly state: PlanState };

export interface MarketPlan {
  readonly market: string;
  readonly symbol: string;
  readonly status: string;
  /** The market's latest plan version; null when it has none. */
  readonly plan: PlanRow | null;
}

export interface ClawbackRow {
  readonly id: string;
  readonly period: string;
  readonly accountId: string;
  readonly market: string | null;
  readonly amount: string;
  readonly asset: string;
  readonly state: 'pending' | 'posted';
  readonly findingRef: string;
  readonly createdAt: string;
}

interface TermsDb {
  version: string;
  tiers: TermsInput['tiers'];
  max_spread_bps: number;
  min_depth: string;
  min_uptime_pct: string;
  cancel_to_fill_ceiling: string;
  clawback_window_days: number;
  equal_access_criteria: string;
  operator_id: string;
  approver_id: string;
  approval_id: string;
  created_at: Date;
}

function termsOf(r: TermsDb): TermsRow {
  return {
    version: r.version,
    tiers: r.tiers,
    maxSpreadBps: String(r.max_spread_bps),
    minDepth: trimDecimal(r.min_depth),
    minUptimePct: trimDecimal(r.min_uptime_pct),
    cancelToFillCeiling: trimDecimal(r.cancel_to_fill_ceiling),
    clawbackWindowDays: String(r.clawback_window_days),
    equalAccessCriteria: r.equal_access_criteria,
    operatorId: r.operator_id,
    approverId: r.approver_id,
    approvalId: r.approval_id,
    writtenAt: r.created_at.toISOString(),
  };
}

interface MemberDb {
  account_id: string;
  version: string;
  tier: string;
  status: MemberStatus;
  conflict_declaration: string;
  terms_version: string;
  operator_id: string;
  approver_id: string;
  approval_id: string;
  updated_at: Date;
}

function memberOf(r: MemberDb): MemberRow {
  return {
    accountId: r.account_id,
    version: r.version,
    tier: r.tier,
    status: r.status,
    conflictDeclaration: r.conflict_declaration,
    termsVersion: r.terms_version,
    operatorId: r.operator_id,
    approverId: r.approver_id,
    approvalId: r.approval_id,
    writtenAt: r.updated_at.toISOString(),
  };
}

interface PlanDb {
  market_id: string;
  symbol: string;
  version: string;
  state: PlanState;
  makers: PlanInput['makers'];
  max_spread_bps: number;
  min_depth: string;
  depth_band_bps: number;
  min_uptime_pct: string;
  inventory_min: string;
  inventory_max: string;
  exit_review_date: string;
  exit_uptime_below_pct: string;
  exit_spread_above_bps: number;
  operator_id: string;
  approver_id: string;
  approval_id: string;
  created_at: Date;
}

function planOf(r: PlanDb): PlanRow {
  return {
    market: r.market_id,
    symbol: r.symbol,
    version: r.version,
    state: r.state,
    makers: r.makers,
    maxSpreadBps: String(r.max_spread_bps),
    minDepth: trimDecimal(r.min_depth),
    depthBandBps: String(r.depth_band_bps),
    minUptimePct: trimDecimal(r.min_uptime_pct),
    inventoryMin: trimDecimal(r.inventory_min),
    inventoryMax: trimDecimal(r.inventory_max),
    exitReviewDate: r.exit_review_date,
    exitUptimeBelowPct: trimDecimal(r.exit_uptime_below_pct),
    exitSpreadAboveBps: String(r.exit_spread_above_bps),
    operatorId: r.operator_id,
    approverId: r.approver_id,
    approvalId: r.approval_id,
    writtenAt: r.created_at.toISOString(),
  };
}

async function latestTerms(sql: Sql): Promise<TermsRow | null> {
  const [row] = await sql<TermsDb[]>`
    SELECT version::text, tiers, max_spread_bps, min_depth::text, min_uptime_pct::text, cancel_to_fill_ceiling::text,
           clawback_window_days, equal_access_criteria, operator_id, approver_id, approval_id, created_at
      FROM trade.maker_programme_terms ORDER BY version DESC LIMIT 1`;
  return row ? termsOf(row) : null;
}

const PLAN_COLUMNS = (sql: Sql) => sql`
  p.market_id::text, m.symbol, p.version::text, p.state, p.makers, p.max_spread_bps, p.min_depth::text, p.depth_band_bps,
  p.min_uptime_pct::text, p.inventory_min::text, p.inventory_max::text, to_char(p.exit_review_date, 'YYYY-MM-DD') AS exit_review_date,
  p.exit_uptime_below_pct::text, p.exit_spread_above_bps, p.operator_id, p.approver_id, p.approval_id, p.created_at`;

export class MakerProgrammeAdmin {
  constructor(private readonly deps: { sql: Sql; approvals: ApprovalBook }) {}

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  async terms(principal: Principal): Promise<{ terms: TermsRow | null }> {
    requireOperator(principal);
    return { terms: await latestTerms(this.deps.sql) };
  }

  async members(principal: Principal): Promise<{ members: MemberRow[] }> {
    requireOperator(principal);
    const rows = await this.deps.sql<MemberDb[]>`
      SELECT account_id::text, version::text, tier, status, conflict_declaration, terms_version::text, operator_id, approver_id,
             approval_id, updated_at
        FROM trade.maker_programme_members ORDER BY updated_at DESC, account_id LIMIT 500`;
    return { members: rows.map(memberOf) };
  }

  async clawbacks(principal: Principal): Promise<{ clawbacks: ClawbackRow[] }> {
    requireOperator(principal);
    const rows = await this.deps.sql<
      Array<{
        id: string;
        period: string;
        account_id: string;
        market_id: string | null;
        amount: string;
        asset: string;
        state: 'pending' | 'posted';
        finding_ref: string;
        created_at: Date;
      }>
    >`
      SELECT id::text, period, account_id::text, market_id::text, amount::text, asset, state, finding_ref, created_at
        FROM trade.maker_clawbacks ORDER BY created_at DESC LIMIT 500`;
    return {
      clawbacks: rows.map((r) => ({
        id: r.id,
        period: r.period,
        accountId: r.account_id,
        market: r.market_id,
        amount: trimDecimal(r.amount),
        asset: r.asset,
        state: r.state,
        findingRef: r.finding_ref,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  /** Every spot market with its latest plan, or null when it has none. */
  async plans(principal: Principal): Promise<{ markets: MarketPlan[] }> {
    requireOperator(principal);
    const sql = this.deps.sql;
    const markets = await sql<Array<{ id: string; symbol: string; status: string }>>`
      SELECT id::text, symbol, status::text FROM trade.markets WHERE kind = 'spot' ORDER BY symbol`;
    const plans = await sql<PlanDb[]>`
      SELECT DISTINCT ON (p.market_id) ${PLAN_COLUMNS(sql)}
        FROM trade.launch_liquidity_plans p JOIN trade.markets m ON m.id = p.market_id
       ORDER BY p.market_id, p.version DESC`;
    const byMarket = new Map(plans.map((p) => [p.market_id, planOf(p)]));
    return { markets: markets.map((m) => ({ market: m.id, symbol: m.symbol, status: m.status, plan: byMarket.get(m.id) ?? null })) };
  }

  async planHistory(principal: Principal, market: string): Promise<{ versions: PlanRow[] }> {
    requireOperator(principal);
    const sql = this.deps.sql;
    const rows = await sql<PlanDb[]>`
      SELECT ${PLAN_COLUMNS(sql)}
        FROM trade.launch_liquidity_plans p JOIN trade.markets m ON m.id = p.market_id
       WHERE p.market_id = ${market} ORDER BY p.version DESC`;
    return { versions: rows.map(planOf) };
  }

  // ── writes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  async setTerms(
    principal: Principal,
    input: { terms: TermsInput; expectedVersion: string; approvalId: string; clientRequestId: string },
  ): Promise<TermsRow> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const terms = must(checkTerms(input.terms));
    const body = termsApprovalBody(input.expectedVersion, terms);
    const fingerprint = payloadHash({ kind: 'maker_programme_terms', ...body });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'maker_programme_terms', fingerprint);
    if (prior) return prior as TermsRow;
    return this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      // One terms writer at a time: a second write bound to the same version waits here and is refused as stale before
      // its approval is spent.
      await q`SELECT pg_advisory_xact_lock(hashtext('trade.maker_programme_terms'))`;
      const [latest] = await q<Array<{ version: string }>>`
        SELECT version::text FROM trade.maker_programme_terms ORDER BY version DESC LIMIT 1`;
      const version = latest?.version ?? '0';
      if (version !== input.expectedVersion) {
        throw new TradeOpsError(
          'trade.maker_programme_stale',
          `the programme terms moved to v${version} since this was proposed; propose again`,
        );
      }
      const consumed = await consumeApproval(this.deps.approvals, {
        approvalId: input.approvalId,
        actionType: MAKER_TERMS_ACTION_TYPE,
        targetId: MAKER_TERMS_TARGET,
        expectedVersion: version,
        payloadHash: payloadHash(body),
        operationId: clientRequestId,
      });
      const next = (BigInt(version) + 1n).toString();
      const writtenAt = new Date();
      await q`INSERT INTO trade.maker_programme_terms (
        version, tiers, max_spread_bps, min_depth, min_uptime_pct, cancel_to_fill_ceiling, clawback_window_days,
        equal_access_criteria, operator_id, approver_id, approval_id, created_at
      ) VALUES (
        ${next}::bigint, ${q.json(terms.tiers as never)}, ${terms.maxSpreadBps}::integer, ${terms.minDepth}::numeric,
        ${terms.minUptimePct}::numeric, ${terms.cancelToFillCeiling}::numeric, ${terms.clawbackWindowDays}::integer,
        ${terms.equalAccessCriteria}, ${principal.userId}, ${consumed.approverId}, ${input.approvalId}, ${writtenAt}
      )`;
      const [stored] = await q<TermsDb[]>`
        SELECT version::text, tiers, max_spread_bps, min_depth::text, min_uptime_pct::text, cancel_to_fill_ceiling::text,
               clawback_window_days, equal_access_criteria, operator_id, approver_id, approval_id, created_at
          FROM trade.maker_programme_terms WHERE version = ${next}::bigint`;
      const row = termsOf(stored!);
      await writeOperatorAudit(q, {
        kind: 'maker_programme.terms',
        operatorId: principal.userId,
        accountId: null,
        objectId: MAKER_TERMS_TARGET,
        approverId: consumed.approverId,
        reason: `programme terms v${next}`,
        detail: { version: next, terms },
      });
      await storeRequest(q, clientRequestId, 'maker_programme_terms', fingerprint, row);
      return row;
    });
  }

  async setMember(
    principal: Principal,
    input: { member: MemberInput; expectedVersion: string; approvalId: string; clientRequestId: string },
  ): Promise<MemberRow> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const member = must(checkMember(input.member));
    const body = memberApprovalBody(input.expectedVersion, member);
    const fingerprint = payloadHash({ kind: 'maker_programme_member', ...body });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'maker_programme_member', fingerprint);
    if (prior) return prior as MemberRow;
    return this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      await q`SELECT pg_advisory_xact_lock(hashtext(${`trade.maker_programme_members:${member.accountId}`}))`;
      // The tier is one the current terms define; with no terms there is no programme to admit anyone to.
      const terms = await latestTerms(q);
      if (!terms)
        throw new TradeOpsError(MAKER_PROGRAMME_TERM_UNSET, 'the programme has no terms; write the terms before admitting a member');
      if (!terms.tiers.some((x) => x.name === member.tier)) {
        throw new TradeOpsError(MAKER_PROGRAMME_TIER_UNKNOWN, `tier ${member.tier} is not in the programme terms v${terms.version}`);
      }
      const [latest] = await q<Array<{ version: string }>>`
        SELECT version::text FROM trade.maker_programme_members WHERE account_id = ${member.accountId}::uuid`;
      const version = latest?.version ?? '0';
      if (version !== input.expectedVersion) {
        throw new TradeOpsError('trade.maker_programme_stale', `this member moved to v${version} since this was proposed; propose again`);
      }
      const consumed = await consumeApproval(this.deps.approvals, {
        approvalId: input.approvalId,
        actionType: MAKER_MEMBER_ACTION_TYPE,
        targetId: member.accountId!,
        expectedVersion: version,
        payloadHash: payloadHash(body),
        operationId: clientRequestId,
      });
      const next = (BigInt(version) + 1n).toString();
      const writtenAt = new Date();
      await q`INSERT INTO trade.maker_programme_members (
        account_id, version, tier, status, conflict_declaration, terms_version, operator_id, approver_id, approval_id, updated_at
      ) VALUES (
        ${member.accountId}::uuid, ${next}::bigint, ${member.tier}, ${member.status}, ${member.conflictDeclaration},
        ${terms.version}::bigint, ${principal.userId}, ${consumed.approverId}, ${input.approvalId}, ${writtenAt}
      )
      ON CONFLICT (account_id) DO UPDATE SET
        version = EXCLUDED.version, tier = EXCLUDED.tier, status = EXCLUDED.status,
        conflict_declaration = EXCLUDED.conflict_declaration, terms_version = EXCLUDED.terms_version,
        operator_id = EXCLUDED.operator_id, approver_id = EXCLUDED.approver_id, approval_id = EXCLUDED.approval_id,
        updated_at = EXCLUDED.updated_at`;
      const row: MemberRow = {
        ...member,
        version: next,
        termsVersion: terms.version,
        operatorId: principal.userId,
        approverId: consumed.approverId,
        approvalId: input.approvalId,
        writtenAt: writtenAt.toISOString(),
      };
      // The audit row keeps every version of the member, since the member row holds only the latest.
      await writeOperatorAudit(q, {
        kind: 'maker_programme.member',
        operatorId: principal.userId,
        accountId: member.accountId,
        objectId: member.accountId!,
        approverId: consumed.approverId,
        reason: `member v${next}: ${member.status}, tier ${member.tier}`,
        detail: { version: next, member, termsVersion: terms.version },
      });
      await storeRequest(q, clientRequestId, 'maker_programme_member', fingerprint, row);
      return row;
    });
  }

  async setPlan(
    principal: Principal,
    input: { market: string; plan: PlanInput; expectedVersion: string; approvalId: string; clientRequestId: string },
  ): Promise<PlanRow> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const plan = must(checkPlan(input.plan));
    // The band's order, exactly, before any approval is spent (the table's CHECK holds it too).
    if (parseAmount(plan.inventoryMin!) > parseAmount(plan.inventoryMax!)) {
      throw new TradeOpsError(LAUNCH_PLAN_INVALID, 'inventory band low is at most its high');
    }
    const body = planApprovalBody(input.market, input.expectedVersion, plan);
    const fingerprint = payloadHash({ kind: 'launch_liquidity_plan', ...body });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'launch_liquidity_plan', fingerprint);
    if (prior) return prior as PlanRow;
    return this.deps.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      // One writer per market at a time, as the seeding configuration does.
      const [market] = await q<Array<{ id: string; symbol: string }>>`
        SELECT id::text, symbol FROM trade.markets WHERE id = ${input.market} AND kind = 'spot' FOR UPDATE`;
      if (!market) throw new TradeOpsError('market_not_found', 'no such spot market');
      // Every maker is an active member of the programme, read in this transaction.
      const accounts = plan.makers.map((m) => m.accountId!);
      const active = await q<Array<{ account_id: string }>>`
        SELECT account_id::text FROM trade.maker_programme_members
         WHERE account_id = ANY(${accounts}::uuid[]) AND status = 'active'`;
      const known = new Set(active.map((r) => r.account_id));
      const unknown = accounts.find((a) => !known.has(a));
      if (unknown) {
        throw new TradeOpsError(LAUNCH_PLAN_MAKER_UNKNOWN, `maker ${unknown} is not an active member of the maker programme`);
      }
      const [latest] = await q<Array<{ version: string }>>`
        SELECT version::text FROM trade.launch_liquidity_plans WHERE market_id = ${input.market} ORDER BY version DESC LIMIT 1`;
      const version = latest?.version ?? '0';
      if (version !== input.expectedVersion) {
        throw new TradeOpsError('trade.launch_plan_stale', `the plan moved to v${version} since this was proposed; propose again`);
      }
      const consumed = await consumeApproval(this.deps.approvals, {
        approvalId: input.approvalId,
        actionType: LAUNCH_PLAN_ACTION_TYPE,
        targetId: input.market,
        expectedVersion: version,
        payloadHash: payloadHash(body),
        operationId: clientRequestId,
      });
      const next = (BigInt(version) + 1n).toString();
      const writtenAt = new Date();
      // Written under a second operator's approval, so the version is approved; it becomes active when its market opens.
      await q`INSERT INTO trade.launch_liquidity_plans (
        market_id, version, state, makers, max_spread_bps, min_depth, depth_band_bps, min_uptime_pct, inventory_min,
        inventory_max, exit_review_date, exit_uptime_below_pct, exit_spread_above_bps, operator_id, approver_id, approval_id,
        created_at
      ) VALUES (
        ${input.market}, ${next}::bigint, 'approved', ${q.json(plan.makers as never)}, ${plan.maxSpreadBps}::integer,
        ${plan.minDepth}::numeric, ${plan.depthBandBps}::integer, ${plan.minUptimePct}::numeric, ${plan.inventoryMin}::numeric,
        ${plan.inventoryMax}::numeric, ${plan.exitReviewDate}::date, ${plan.exitUptimeBelowPct}::numeric,
        ${plan.exitSpreadAboveBps}::integer, ${principal.userId}, ${consumed.approverId}, ${input.approvalId}, ${writtenAt}
      )`;
      const [stored] = await q<PlanDb[]>`
        SELECT ${PLAN_COLUMNS(q)}
          FROM trade.launch_liquidity_plans p JOIN trade.markets m ON m.id = p.market_id
         WHERE p.market_id = ${input.market} AND p.version = ${next}::bigint`;
      const row = planOf(stored!);
      await writeOperatorAudit(q, {
        kind: 'launch_liquidity.plan',
        operatorId: principal.userId,
        accountId: null,
        objectId: input.market,
        approverId: consumed.approverId,
        reason: `launch-liquidity plan v${next} for ${market.symbol}`,
        detail: { version: next, plan },
      });
      await storeRequest(q, clientRequestId, 'launch_liquidity_plan', fingerprint, row);
      return row;
    });
  }
}
