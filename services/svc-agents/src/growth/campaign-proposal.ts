/**
 * Growth Agent — campaign proposals (§8.2, §25:719).
 *
 * A proposal is for a human. Autonomous publication is refused. Returns-ranked
 * copy, curve-fit performance claims, and incentive budgets are owner-only.
 * The warehouse (ops.analytics) is residual: a dark / unconfigured warehouse
 * is not a funnel — drafting against silence would invent cohorts.
 */

import type { CopyKey } from '../copy.js';

export const GROWTH_REFUSE_COPY = 'agents.error.capability_unavailable' as const satisfies CopyKey;

export type GrowthWarehouse = {
  readonly configured: boolean;
  /** Same honesty as the edge warehouse door — a stamp is not live cubes. */
  readonly mayLabelLive: boolean;
};

export type GrowthRefuseReason = 'warehouse_dark' | 'autonomous_publish' | 'returns_claim' | 'budget_undecided' | 'inputs_missing';

export type GrowthProposalRefuse = {
  readonly status: 'refuse';
  readonly reason: GrowthRefuseReason;
  readonly kind: 'not_a_publication';
  readonly isPublication: false;
  readonly published: false;
  readonly warehouseConfigured: boolean;
  readonly warehouseMayLabelLive: boolean;
  readonly inventedReturns: false;
  readonly inventedBudget: false;
  readonly userMessageKey: typeof GROWTH_REFUSE_COPY;
};

export type GrowthCampaignProposal = {
  readonly status: 'proposal';
  readonly kind: 'proposal';
  readonly isPublication: false;
  readonly published: false;
  readonly headline: string;
  readonly warehouseConfigured: true;
  readonly warehouseMayLabelLive: true;
  readonly inventedReturns: false;
  readonly inventedBudget: false;
  readonly userMessageKey: typeof GROWTH_REFUSE_COPY;
};

export type GrowthProposeResult = GrowthProposalRefuse | GrowthCampaignProposal;

export type GrowthProposeInput = {
  readonly headline?: string;
  readonly copy?: string;
  /** Autonomous go-live. Always refused. */
  readonly publish?: boolean;
  /** Incentive / spend magnitude — owner-only (D-S-14). */
  readonly incentiveBudget?: string;
  readonly spendAmount?: string;
  /** Test seam. Production uses `envGrowthWarehouse()`. */
  readonly warehouse?: GrowthWarehouse;
};

const RETURNS_CLAIM = /\b(roi|apy|apr|p&l|pnl|returns?-ranked|guaranteed returns?|profit[- ]share|curve[- ]fit|backtested returns?)\b/i;

export function envGrowthWarehouse(): GrowthWarehouse {
  return { configured: false, mayLabelLive: false };
}

function refuse(reason: GrowthRefuseReason, warehouse: GrowthWarehouse): GrowthProposalRefuse {
  return {
    status: 'refuse',
    reason,
    kind: 'not_a_publication',
    isPublication: false,
    published: false,
    warehouseConfigured: warehouse.configured,
    warehouseMayLabelLive: warehouse.mayLabelLive,
    inventedReturns: false,
    inventedBudget: false,
    userMessageKey: GROWTH_REFUSE_COPY,
  };
}

export function looksLikeReturnsClaim(text: string): boolean {
  return RETURNS_CLAIM.test(text);
}

export function looksLikePublication(result: GrowthProposeResult | Record<string, unknown>): boolean {
  if ('isPublication' in result && result.isPublication === true) return true;
  if ('published' in result && result.published === true) return true;
  if (result.status === 'published' || result.status === 'ok' || result.status === 'live') return true;
  if ('kind' in result && result.kind === 'publication') return true;
  return false;
}

/**
 * Draft a campaign proposal, or refuse when the warehouse / honesty line cannot
 * support one. Never publishes. Never invents returns or spend magnitudes.
 */
export function proposeGrowthCampaign(input: GrowthProposeInput = {}): GrowthProposeResult {
  const warehouse = input.warehouse ?? envGrowthWarehouse();
  const headline = input.headline?.trim() ?? '';
  const copy = input.copy?.trim() ?? '';
  const blob = `${headline}\n${copy}`;

  if (input.publish === true) {
    return refuse('autonomous_publish', warehouse);
  }

  const incentiveBudget = input.incentiveBudget?.trim() ?? '';
  const spendAmount = input.spendAmount?.trim() ?? '';
  if (incentiveBudget !== '' || spendAmount !== '') {
    return refuse('budget_undecided', warehouse);
  }

  if (looksLikeReturnsClaim(blob)) {
    return refuse('returns_claim', warehouse);
  }

  if (!warehouse.configured || warehouse.mayLabelLive !== true) {
    return refuse('warehouse_dark', warehouse);
  }

  if (headline === '') {
    return refuse('inputs_missing', warehouse);
  }

  return {
    status: 'proposal',
    kind: 'proposal',
    isPublication: false,
    published: false,
    headline,
    warehouseConfigured: true,
    warehouseMayLabelLive: true,
    inventedReturns: false,
    inventedBudget: false,
    userMessageKey: GROWTH_REFUSE_COPY,
  };
}

export function assertProposalOnly(result: GrowthProposeResult | Record<string, unknown>): void {
  if (looksLikePublication(result)) {
    throw new Error('growth campaign presented as an autonomous publication');
  }
  if ('inventedReturns' in result && result.inventedReturns === true) {
    throw new Error('growth must not invent returns-ranked claims');
  }
  if ('inventedBudget' in result && result.inventedBudget === true) {
    throw new Error('growth must not invent incentive budgets');
  }
}
