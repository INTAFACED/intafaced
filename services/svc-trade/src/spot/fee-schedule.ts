/**
 * PTX-M21 owner fee/rebate schedule — refuse-closed when unpublished.
 *
 * Commercial magnitudes are OWNER-SET. Blank env is not 10/20 bps and is not
 * zero. Preview and place/fill hitch this; silence never invents a rate.
 *
 * Bps arrive as decimal strings (never a JSON number) and become integer counts
 * in memory. Fee *amounts* stay ledger decimal strings via `mulBps`.
 */

import { logRefusalSpec } from '../refusal-spec-log.js';

export const TRADE_FEE_SCHEDULE_ENV = 'TRADE_FEE_SCHEDULE' as const;

export const FEE_SCHEDULE_RESIDUAL = 'Trading fees are not available yet: the maker and taker schedule is not set.';

export type FeeScheduleErrorCode = 'trade.fee_schedule_blank' | 'trade.fee_schedule_invalid';

export class FeeScheduleError extends Error {
  constructor(
    message: string,
    readonly code: FeeScheduleErrorCode,
    readonly residual: string = FEE_SCHEDULE_RESIDUAL,
  ) {
    super(message);
    this.name = 'FeeScheduleError';
  }
}

export type OwnerFeeSchedule =
  | { readonly published: false }
  | {
      readonly published: true;
      readonly version: string;
      readonly makerBps: number;
      readonly takerBps: number;
      /**
       * Maker rebate in bps of notional. Null = unpublished (silence is not
       * zero; negative rebate policy stays closed until owner funds it).
       */
      readonly makerRebateBps: number | null;
    };

export const UNPUBLISHED_FEE_SCHEDULE: OwnerFeeSchedule = { published: false };

const INTEGER_BPS = /^[0-9]{1,4}$/;

function parseBpsDecimalString(raw: unknown, field: string): number {
  if (typeof raw !== 'string' || !INTEGER_BPS.test(raw)) {
    throw new FeeScheduleError(
      `${TRADE_FEE_SCHEDULE_ENV}.${field} must be a decimal string of integer 0..9999 (never a JSON number)`,
      'trade.fee_schedule_blank',
    );
  }
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new FeeScheduleError(
      `${TRADE_FEE_SCHEDULE_ENV}.${field} must be a decimal string of integer 0..9999`,
      'trade.fee_schedule_blank',
    );
  }
  return bps;
}

function parseOptionalRebateBps(raw: unknown): number | null {
  if (raw === undefined) return null;
  return parseBpsDecimalString(raw, 'makerRebateBps');
}

/**
 * Parse owner-published maker/taker schedule from env JSON.
 * Empty / whitespace → unpublished. Invalid → throw (fail boot, do not invent).
 */
export function parseFeeScheduleJson(raw: string | null | undefined): OwnerFeeSchedule {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_FEE_SCHEDULE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new FeeScheduleError(`${TRADE_FEE_SCHEDULE_ENV} is not valid JSON`, 'trade.fee_schedule_invalid');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FeeScheduleError(`${TRADE_FEE_SCHEDULE_ENV} must be an object`, 'trade.fee_schedule_invalid');
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.published === false) return UNPUBLISHED_FEE_SCHEDULE;
  if (obj.published !== true) {
    throw new FeeScheduleError(`${TRADE_FEE_SCHEDULE_ENV}.published must be true or false`, 'trade.fee_schedule_blank');
  }

  if (typeof obj.version !== 'string' || !obj.version.trim()) {
    throw new FeeScheduleError(`${TRADE_FEE_SCHEDULE_ENV}.version must be a non-empty string`, 'trade.fee_schedule_blank');
  }

  const makerBps = parseBpsDecimalString(obj.makerBps, 'makerBps');
  const takerBps = parseBpsDecimalString(obj.takerBps, 'takerBps');
  const makerRebateBps = parseOptionalRebateBps(obj.makerRebateBps);

  return {
    published: true,
    version: obj.version.trim(),
    makerBps,
    takerBps,
    makerRebateBps,
  };
}

export function previewFeeBps(schedule: OwnerFeeSchedule, role: 'maker' | 'taker'): number | null {
  if (schedule.published !== true) return null;
  return role === 'maker' ? schedule.makerBps : schedule.takerBps;
}

/**
 * Place/fill hitch. Unpublished is a typed refuse — never listing-row 10/20.
 */
export function requirePublishedFeeSchedule(schedule: OwnerFeeSchedule): Extract<OwnerFeeSchedule, { published: true }> {
  if (schedule.published !== true) {
    logRefusalSpec('trade.fee_schedule_blank');
    throw new FeeScheduleError('Trading fees are not available yet: the maker and taker schedule is not set.', 'trade.fee_schedule_blank');
  }
  return schedule;
}
