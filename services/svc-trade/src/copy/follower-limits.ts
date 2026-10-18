/**
 * PTX-M26-R02 — follower allocation / instrument / loss caps.
 *
 * Leader (or platform) settings are recommendations only. Bind takes the
 * tighter number and the instrument intersection. A missing follower limit
 * refuses rather than inheriting the leader's. Leader values never raise
 * a follower cap.
 */

import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { CopyError } from './errors.js';
import { parseOptionalConcurrent, parseOptionalDrawdown, parseOptionalSlippageBps } from './follow-limits-extra.js';
import type { CopyEnvelope } from './follows.js';

export type CopyLeaderLimitSettings = {
  readonly maxAllocation?: string | null;
  readonly permittedInstruments?: readonly string[] | null;
  readonly maxLoss?: string | null;
  readonly maxSlippageBps?: number | null;
  readonly maxConcurrent?: number | null;
  readonly maxDrawdown?: string | null;
};

export type CopyFollowerLimitInput = {
  readonly maxAllocation?: string | null;
  readonly permittedInstruments?: readonly string[] | null;
  readonly maxLoss?: string | null;
  readonly maxSlippageBps?: number | null;
  readonly maxConcurrent?: number | null;
  readonly maxDrawdown?: string | null;
};

export type BoundCopyFollowerLimits = {
  readonly maxAllocation: Amount;
  readonly permittedInstruments: readonly string[];
  readonly maxLoss: Amount | null;
  readonly maxSlippageBps: number | null;
  readonly maxConcurrent: number | null;
  readonly maxDrawdown: Amount | null;
};

function present(raw: string | null | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveCap(raw: string, axis: 'allocation' | 'loss', owner: 'follower' | 'leader'): Amount {
  let amount: Amount;
  try {
    amount = parseAmount(raw);
  } catch {
    throw new CopyError(`${owner} ${axis} limit must be a valid decimal amount`, 'trade.copy_envelope_invalid');
  }
  if (amount <= 0n) {
    throw new CopyError(`${owner} ${axis} limit must be strictly positive`, 'trade.copy_envelope_invalid');
  }
  return amount;
}

function requireFollowerAllocation(raw: string | null | undefined): Amount {
  const presentRaw = present(raw);
  if (!presentRaw) {
    throw new CopyError('Follower allocation limit is required — refuse rather than inherit a leader cap', 'trade.copy_limit_missing');
  }
  return parsePositiveCap(presentRaw, 'allocation', 'follower');
}

function requireFollowerInstruments(raw: readonly string[] | null | undefined): readonly string[] {
  const markets = (raw ?? []).map((m) => m.trim()).filter(Boolean);
  if (markets.length === 0) {
    throw new CopyError('Follower instrument universe is required — refuse rather than inherit a leader list', 'trade.copy_limit_missing');
  }
  return markets;
}

function parseOptionalLeaderCap(raw: string | null | undefined, axis: 'allocation' | 'loss'): Amount | undefined {
  const presentRaw = present(raw);
  if (!presentRaw) return undefined;
  return parsePositiveCap(presentRaw, axis, 'leader');
}

function parseOptionalLeaderInstruments(raw: readonly string[] | null | undefined): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return raw.map((m) => m.trim()).filter(Boolean);
}

/**
 * Compose independent follower caps with optional leader recommendations.
 * Missing follower allocation/instruments always refuse. Follower maxLoss,
 * slippage, concurrency and drawdown refuse when that axis is in play
 * (follower or leader supplied it). A leader value can only tighten.
 */
export function bindCopyFollowerLimits(input: {
  follower: CopyFollowerLimitInput;
  leader?: CopyLeaderLimitSettings | null;
}): BoundCopyFollowerLimits {
  const maxAllocation = requireFollowerAllocation(input.follower.maxAllocation);
  const permittedInstruments = requireFollowerInstruments(input.follower.permittedInstruments);

  const leader = input.leader ?? null;
  const leaderAllocation = leader ? parseOptionalLeaderCap(leader.maxAllocation, 'allocation') : undefined;
  const leaderInstruments = leader ? parseOptionalLeaderInstruments(leader.permittedInstruments) : undefined;
  const leaderLoss = leader ? parseOptionalLeaderCap(leader.maxLoss, 'loss') : undefined;

  const followerLossRaw = present(input.follower.maxLoss);
  const lossAxisRequired = followerLossRaw !== undefined || leaderLoss !== undefined;
  let maxLoss: Amount | null = null;
  if (lossAxisRequired) {
    if (!followerLossRaw) {
      throw new CopyError('Follower loss limit is required — refuse rather than inherit a leader cap', 'trade.copy_limit_missing');
    }
    maxLoss = parsePositiveCap(followerLossRaw, 'loss', 'follower');
  }

  let allocation = maxAllocation;
  if (leaderAllocation !== undefined && leaderAllocation < allocation) {
    allocation = leaderAllocation;
  }

  let instruments = permittedInstruments;
  if (leaderInstruments !== undefined) {
    const allowed = new Set(leaderInstruments);
    instruments = permittedInstruments.filter((m) => allowed.has(m));
    if (instruments.length === 0) {
      throw new CopyError(
        'Leader instrument universe cannot replace follower instruments — intersection is empty',
        'trade.copy_market_not_permitted',
      );
    }
  }

  if (maxLoss !== null && leaderLoss !== undefined && leaderLoss < maxLoss) {
    maxLoss = leaderLoss;
  }

  const leaderSlippage = leader ? parseOptionalSlippageBps(leader.maxSlippageBps, 'leader') : undefined;
  const followerSlippage = parseOptionalSlippageBps(input.follower.maxSlippageBps, 'follower');
  let maxSlippageBps: number | null = null;
  if (followerSlippage !== undefined || leaderSlippage !== undefined) {
    if (followerSlippage === undefined) {
      throw new CopyError('Follower slippage limit is required — refuse rather than inherit a leader cap', 'trade.copy_limit_missing');
    }
    maxSlippageBps = followerSlippage;
    if (leaderSlippage !== undefined && leaderSlippage < maxSlippageBps) maxSlippageBps = leaderSlippage;
  }

  const leaderConcurrent = leader ? parseOptionalConcurrent(leader.maxConcurrent, 'leader') : undefined;
  const followerConcurrent = parseOptionalConcurrent(input.follower.maxConcurrent, 'follower');
  let maxConcurrent: number | null = null;
  if (followerConcurrent !== undefined || leaderConcurrent !== undefined) {
    if (followerConcurrent === undefined) {
      throw new CopyError('Follower concurrency limit is required — refuse rather than inherit a leader cap', 'trade.copy_limit_missing');
    }
    maxConcurrent = followerConcurrent;
    if (leaderConcurrent !== undefined && leaderConcurrent < maxConcurrent) maxConcurrent = leaderConcurrent;
  }

  const leaderDrawdown = leader ? parseOptionalDrawdown(leader.maxDrawdown, 'leader') : undefined;
  const followerDrawdown = parseOptionalDrawdown(input.follower.maxDrawdown, 'follower');
  let maxDrawdown: Amount | null = null;
  if (followerDrawdown !== undefined || leaderDrawdown !== undefined) {
    if (followerDrawdown === undefined) {
      throw new CopyError('Follower drawdown limit is required — refuse rather than inherit a leader cap', 'trade.copy_limit_missing');
    }
    maxDrawdown = followerDrawdown;
    if (leaderDrawdown !== undefined && leaderDrawdown < maxDrawdown) maxDrawdown = leaderDrawdown;
  }

  return {
    maxAllocation: allocation,
    permittedInstruments: instruments,
    maxLoss,
    maxSlippageBps,
    maxConcurrent,
    maxDrawdown,
  };
}

export function followerLimitsFromEnvelope(envelope: CopyEnvelope): CopyFollowerLimitInput {
  return {
    maxAllocation: formatAmount(envelope.maxAggregateExposure),
    permittedInstruments: envelope.permittedMarkets,
    maxLoss: envelope.maxLoss !== undefined ? formatAmount(envelope.maxLoss) : undefined,
    maxSlippageBps: envelope.maxSlippageBps,
    maxConcurrent: envelope.maxConcurrent,
    maxDrawdown: envelope.maxDrawdown !== undefined ? formatAmount(envelope.maxDrawdown) : undefined,
  };
}

export function envelopeWithBoundLimits(envelope: CopyEnvelope, bound: BoundCopyFollowerLimits): CopyEnvelope {
  const maxNotionalPerOrder = envelope.maxNotionalPerOrder > bound.maxAllocation ? bound.maxAllocation : envelope.maxNotionalPerOrder;
  return {
    ...envelope,
    permittedMarkets: bound.permittedInstruments,
    maxAggregateExposure: bound.maxAllocation,
    maxNotionalPerOrder,
    ...(bound.maxLoss !== null ? { maxLoss: bound.maxLoss } : {}),
    ...(bound.maxSlippageBps !== null ? { maxSlippageBps: bound.maxSlippageBps } : {}),
    ...(bound.maxConcurrent !== null ? { maxConcurrent: bound.maxConcurrent } : {}),
    ...(bound.maxDrawdown !== null ? { maxDrawdown: bound.maxDrawdown } : {}),
  };
}

export function bindEnvelopeLimits(envelope: CopyEnvelope, leader?: CopyLeaderLimitSettings | null): CopyEnvelope {
  return envelopeWithBoundLimits(envelope, bindCopyFollowerLimits({ follower: followerLimitsFromEnvelope(envelope), leader }));
}
