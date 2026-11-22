/**
 * R-onboard hitch: limit / fee-tier change needs two distinct actors.
 * Reuses four-eyes. Does not invent a second approver, a threshold, or bps.
 * Writes rank_thresholds.perks (feeDiscountBps / p2pLimitMultiplier) only.
 * Missing rank row refuses — never inserts a ladder. Malformed perks refuse — never BASE_PERKS.
 */
import type { Sql } from 'postgres';
import type { RankPerks } from '@intafaced/contracts';
import { rankPerksSchema } from '@intafaced/contracts/identity';
import { type DualControlCmd } from '../auth/four-eyes.js';
import {
  ACTION_APPROVAL_MISSING,
  PrivilegedDualControlError,
  requirePrivilegedDualControl,
  type PrivilegedApprovalCmd,
} from '../auth/privileged-dual-control.js';
import type { ActionApprovalService } from '../auth/action-approval-service.js';
import type { RankService } from './rank-service.js';

export const FEE_TIER_BPS_REQUIRED = 'identity.fee_tier_bps_required' as const;
export const FEE_TIER_BPS_INVALID = 'identity.fee_tier_bps_invalid' as const;
export const LIMIT_MULTIPLIER_REQUIRED = 'identity.limit_multiplier_required' as const;
export const LIMIT_MULTIPLIER_INVALID = 'identity.limit_multiplier_invalid' as const;
export const RANK_REQUIRED = 'identity.rank_required' as const;
export const RANK_NOT_FOUND = 'identity.rank_not_found' as const;
export const PERKS_UNREADABLE = 'identity.perks_unreadable' as const;

export type LimitFeeTierCode =
  | PrivilegedDualControlError['code']
  | typeof ACTION_APPROVAL_MISSING
  | typeof FEE_TIER_BPS_REQUIRED
  | typeof FEE_TIER_BPS_INVALID
  | typeof LIMIT_MULTIPLIER_REQUIRED
  | typeof LIMIT_MULTIPLIER_INVALID
  | typeof RANK_REQUIRED
  | typeof RANK_NOT_FOUND
  | typeof PERKS_UNREADABLE;

export class LimitFeeTierError extends Error {
  constructor(
    message: string,
    readonly code: LimitFeeTierCode,
  ) {
    super(message);
    this.name = 'LimitFeeTierError';
  }
}

const FLAG = Symbol.for('intafaced.identity.limit-fee-tier-dual-control');

export type LimitFeeTierView = {
  readonly rank: number;
  readonly feeDiscountBps: number;
  readonly p2pLimitMultiplier: number;
};

function requireRank(value: number | null | undefined): number {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new LimitFeeTierError('rank is required', RANK_REQUIRED);
  }
  return value;
}

/** Caller must name the bps. Identity does not invent 0 / 10 / 20. */
export function requireFeeDiscountBps(value: number | null | undefined): number {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isInteger(value)) {
    throw new LimitFeeTierError('feeDiscountBps is required; identity does not invent fee-tier bps', FEE_TIER_BPS_REQUIRED);
  }
  if (value < 0 || value > 10_000) {
    throw new LimitFeeTierError('feeDiscountBps is out of range', FEE_TIER_BPS_INVALID);
  }
  return value;
}

/** Caller must name the multiplier. Identity does not invent 1. */
export function requireLimitMultiplier(value: number | null | undefined): number {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LimitFeeTierError('p2pLimitMultiplier is required; identity does not invent a limit', LIMIT_MULTIPLIER_REQUIRED);
  }
  if (value < 1) {
    throw new LimitFeeTierError('p2pLimitMultiplier is out of range', LIMIT_MULTIPLIER_INVALID);
  }
  return value;
}

function readPerks(raw: unknown): RankPerks {
  const parsed = rankPerksSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LimitFeeTierError('rank perks are unreadable; identity does not invent a fee-tier', PERKS_UNREADABLE);
  }
  return parsed.data;
}

async function dualOrThrow(approvals: Pick<ActionApprovalService, 'consume'>, cmd: PrivilegedApprovalCmd): Promise<void> {
  try {
    await requirePrivilegedDualControl(approvals, cmd);
  } catch (err) {
    if (err instanceof PrivilegedDualControlError) {
      throw new LimitFeeTierError(err.message, err.code);
    }
    throw err;
  }
}

async function loadRow(sql: Sql, rank: number): Promise<{ rank: number; perks: RankPerks }> {
  const rows = await sql<Array<{ rank: number; perks: unknown }>>`
    SELECT rank, perks FROM rank_thresholds WHERE rank = ${rank} LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw new LimitFeeTierError('Rank threshold not found', RANK_NOT_FOUND);
  }
  return { rank: row.rank, perks: readPerks(row.perks) };
}

async function writePerks(sql: Sql, rank: number, perks: RankPerks, reload?: Pick<RankService, 'loadTiers'>): Promise<LimitFeeTierView> {
  await sql`
    UPDATE rank_thresholds SET perks = ${sql.json(perks as never)} WHERE rank = ${rank}
  `;
  if (reload) await reload.loadTiers();
  return { rank, feeDiscountBps: perks.feeDiscountBps, p2pLimitMultiplier: perks.p2pLimitMultiplier };
}

export async function changeFeeTier(
  sql: Sql,
  input: { rank: number | null | undefined; feeDiscountBps: number | null | undefined },
  cmd: PrivilegedApprovalCmd,
  reload: Pick<RankService, 'loadTiers'> | undefined,
  approvals: Pick<ActionApprovalService, 'consume'>,
): Promise<LimitFeeTierView> {
  await dualOrThrow(approvals, { ...cmd, targetId: cmd.targetId || 'identity.change_fee_tier' });
  const rank = requireRank(input.rank);
  const feeDiscountBps = requireFeeDiscountBps(input.feeDiscountBps);
  const row = await loadRow(sql, rank);
  return writePerks(sql, rank, { ...row.perks, feeDiscountBps }, reload);
}

export async function changeLimit(
  sql: Sql,
  input: { rank: number | null | undefined; p2pLimitMultiplier: number | null | undefined },
  cmd: PrivilegedApprovalCmd,
  reload: Pick<RankService, 'loadTiers'> | undefined,
  approvals: Pick<ActionApprovalService, 'consume'>,
): Promise<LimitFeeTierView> {
  await dualOrThrow(approvals, { ...cmd, targetId: cmd.targetId || 'identity.change_limit' });
  const rank = requireRank(input.rank);
  const p2pLimitMultiplier = requireLimitMultiplier(input.p2pLimitMultiplier);
  const row = await loadRow(sql, rank);
  return writePerks(sql, rank, { ...row.perks, p2pLimitMultiplier }, reload);
}

/** Boot hitch — dual-control writes go through RankService. Idempotent. */
export function installLimitFeeTierDualControl(rank: RankService, sql: Sql, approvals: Pick<ActionApprovalService, 'consume'>): void {
  const tagged = rank as RankService & { [FLAG]?: true };
  if (tagged[FLAG]) return;
  tagged[FLAG] = true;

  const bound = rank as RankService & {
    changeFeeTier: (
      input: { rank: number | null | undefined; feeDiscountBps: number | null | undefined },
      cmd: DualControlCmd,
    ) => Promise<LimitFeeTierView>;
    changeLimit: (
      input: { rank: number | null | undefined; p2pLimitMultiplier: number | null | undefined },
      cmd: DualControlCmd,
    ) => Promise<LimitFeeTierView>;
  };
  bound.changeFeeTier = (input, cmd) => changeFeeTier(sql, input, { ...cmd, targetId: 'identity.change_fee_tier' }, rank, approvals);
  bound.changeLimit = (input, cmd) => changeLimit(sql, input, { ...cmd, targetId: 'identity.change_limit' }, rank, approvals);
}
