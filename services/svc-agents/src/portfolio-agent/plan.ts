/**
 * v2 Portfolio Agent — plan-only rebalance.
 *
 * Compares holdings vs owner-supplied targets. Never places an order, never
 * posts ledger, never invents a book or a 60/40. Cross-plane legs refuse
 * (ADR 2026-08-04) — this is not a bridge.
 */

import { appendPortfolioAudit, emptyPortfolioAuditLog, type PortfolioAuditLog } from './audit.js';
import { isPortfolioAgentKilled } from './kill-switch.js';
import type { AssetPlane, PortfolioPort, TargetWeight } from './port.js';
import { formatWeight, parseWeight, weightUnit } from './weights.js';

export type PlanRebalanceInput = {
  readonly userId: string;
  readonly targets?: readonly TargetWeight[] | null;
};

export type PlanRebalanceDeps = {
  /** Unset → named dark refuse. Never invent holdings. */
  readonly portfolio?: PortfolioPort | null;
  /** When set, beats env. */
  readonly killed?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly audit?: PortfolioAuditLog;
};

export type RebalanceLeg = {
  readonly asset: string;
  readonly plane: AssetPlane;
  readonly currentWeight: string;
  readonly targetWeight: string;
  readonly deltaWeight: string;
  readonly intent: 'increase' | 'reduce';
};

export type PlannedRebalance = {
  readonly status: 'planned';
  readonly userId: string;
  readonly legs: readonly RebalanceLeg[];
};

export type RefusedRebalance = {
  readonly status: 'refused';
  readonly code:
    'portfolio.killed' | 'portfolio.port_dark' | 'portfolio.target_unset' | 'portfolio.holding_unread' | 'portfolio.cross_plane_blocked';
  readonly userMessageKey: 'agents.refused.module_not_allowed';
};

export type PlanRebalanceResult = PlannedRebalance | RefusedRebalance;

export type PlanRebalanceOutcome = {
  readonly result: PlanRebalanceResult;
  readonly audit: PortfolioAuditLog;
};

const REFUSE_KEY = 'agents.refused.module_not_allowed' as const;
const PLANNED_KEY = 'agents.action.executed';

function refuse(
  code: RefusedRebalance['code'],
  audit: PortfolioAuditLog,
  occurredAt: string,
  extra: Record<string, unknown> = {},
): PlanRebalanceOutcome {
  const result: RefusedRebalance = { status: 'refused', code, userMessageKey: REFUSE_KEY };
  return {
    result,
    audit: appendPortfolioAudit(audit, {
      status: 'refused',
      refusalCode: code,
      userMessageKey: REFUSE_KEY,
      payload: { ...result, ...extra },
      occurredAt,
    }),
  };
}

function ownerTargets(raw: PlanRebalanceInput['targets']): Map<string, { plane: AssetPlane; weight: bigint }> | null {
  if (!raw || raw.length === 0) return null;
  const unit = weightUnit();
  const map = new Map<string, { plane: AssetPlane; weight: bigint }>();
  let sum = 0n;
  for (const t of raw) {
    if (!t || typeof t.asset !== 'string' || t.asset.length === 0) return null;
    if (t.plane !== 'custodial' && t.plane !== 'sovereign') return null;
    if (t.weight === undefined || t.weight === null || t.weight === '') return null;
    const w = parseWeight(t.weight);
    if (w === null) return null;
    const key = `${t.plane}:${t.asset}`;
    if (map.has(key)) return null;
    map.set(key, { plane: t.plane, weight: w });
    sum += w;
  }
  if (sum !== unit) return null;
  return map;
}

function planeTotal(book: Map<string, { plane: AssetPlane; weight: bigint }>, plane: AssetPlane): bigint {
  let total = 0n;
  for (const row of book.values()) {
    if (row.plane === plane) total += row.weight;
  }
  return total;
}

/** True when one plane's total falls and the other plane's total rises (a bridge, not a trade). */
function crossesPlanes(
  current: Map<string, { plane: AssetPlane; weight: bigint }>,
  targets: Map<string, { plane: AssetPlane; weight: bigint }>,
): boolean {
  const custodialDelta = planeTotal(targets, 'custodial') - planeTotal(current, 'custodial');
  const sovereignDelta = planeTotal(targets, 'sovereign') - planeTotal(current, 'sovereign');
  return (custodialDelta < 0n && sovereignDelta > 0n) || (sovereignDelta < 0n && custodialDelta > 0n);
}

/**
 * Compare holdings vs targets. Output is a plan. Execution is not in this slice.
 */
export function planRebalance(input: PlanRebalanceInput, deps: PlanRebalanceDeps = {}): PlanRebalanceOutcome {
  const occurredAt = (deps.now ?? (() => new Date()))().toISOString();
  const audit = deps.audit ?? emptyPortfolioAuditLog();
  const killed = deps.killed ?? isPortfolioAgentKilled(deps.env ?? process.env);

  if (killed) {
    return refuse('portfolio.killed', audit, occurredAt, { userId: input.userId });
  }

  if (!deps.portfolio) {
    return refuse('portfolio.port_dark', audit, occurredAt, { userId: input.userId });
  }

  const targets = ownerTargets(input.targets);
  if (!targets) {
    return refuse('portfolio.target_unset', audit, occurredAt, { userId: input.userId });
  }

  const snapshot = deps.portfolio.read(input.userId);
  if (snapshot.unread.length > 0) {
    return refuse('portfolio.holding_unread', audit, occurredAt, {
      userId: input.userId,
      unread: snapshot.unread,
    });
  }

  const current = new Map<string, { plane: AssetPlane; weight: bigint }>();
  for (const h of snapshot.holdings) {
    const w = parseWeight(h.weight);
    if (w === null) {
      return refuse('portfolio.port_dark', audit, occurredAt, {
        userId: input.userId,
        unread: [{ asset: h.asset, plane: h.plane, reason: 'unparseable_weight' }],
      });
    }
    const key = `${h.plane}:${h.asset}`;
    const prev = current.get(key);
    current.set(key, { plane: h.plane, weight: (prev?.weight ?? 0n) + w });
  }

  if (crossesPlanes(current, targets)) {
    return refuse('portfolio.cross_plane_blocked', audit, occurredAt, { userId: input.userId });
  }

  const blankHoldings = snapshot.holdings.filter((h) => h.asset.length === 0);
  if (blankHoldings.length > 0) {
    return refuse('portfolio.holding_unread', audit, occurredAt, {
      userId: input.userId,
      unread: blankHoldings.map((h) => ({
        asset: h.asset,
        plane: h.plane,
        weight: h.weight,
        reason: 'empty_asset',
      })),
    });
  }

  const keys = new Set([...current.keys(), ...targets.keys()]);
  const legs: RebalanceLeg[] = [];
  for (const key of [...keys].sort()) {
    const sep = key.indexOf(':');
    const plane = key.slice(0, sep) as AssetPlane;
    const asset = key.slice(sep + 1);
    const cur = current.get(key)?.weight ?? 0n;
    const tgt = targets.get(key)?.weight ?? 0n;
    if (cur === tgt) continue;
    const delta = tgt - cur;
    legs.push({
      asset,
      plane,
      currentWeight: formatWeight(cur),
      targetWeight: formatWeight(tgt),
      deltaWeight: formatWeight(delta),
      intent: delta > 0n ? 'increase' : 'reduce',
    });
  }

  const result: PlannedRebalance = { status: 'planned', userId: input.userId, legs };
  return {
    result,
    audit: appendPortfolioAudit(audit, {
      status: 'executed',
      refusalCode: null,
      userMessageKey: PLANNED_KEY,
      payload: result,
      occurredAt,
    }),
  };
}
