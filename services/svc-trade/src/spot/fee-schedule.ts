/**
 * PTX-M21 owner fee/rebate schedule — refuse-closed when unpublished.
 *
 * Commercial magnitudes are OWNER-SET. Blank env is not 10/20 bps and is not
 * zero. Preview and place/fill hitch this; silence never invents a rate.
 *
 * Bps arrive as decimal strings (never a JSON number) and become integer counts
 * in memory. Fee *amounts* stay ledger decimal strings via `mulBps`.
 */

export const TRADE_FEE_SCHEDULE_ENV = 'TRADE_FEE_SCHEDULE' as const;

export const FEE_SCHEDULE_RESIDUAL = 'PTX-M21 fee/rebate schedule is owner-only — refuse-closed (never invent bps)';

export type FeeScheduleErrorCode = 'trade.fee_schedule_blank' | 'trade.fee_schedule_invalid' | 'trade.fee_product_unpublished';

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
      /**
       * Perpetual maker/taker. Null means unpublished. The spot rates above are
       * not a substitute.
       */
      readonly perpetual: { readonly makerBps: number; readonly takerBps: number } | null;
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
  const perpetual = parsePerpetualRates(obj.perpetual);

  return {
    published: true,
    version: obj.version.trim(),
    makerBps,
    takerBps,
    makerRebateBps,
    perpetual,
  };
}

function parsePerpetualRates(raw: unknown): { makerBps: number; takerBps: number } | null {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FeeScheduleError(`${TRADE_FEE_SCHEDULE_ENV}.perpetual must be an object`, 'trade.fee_schedule_blank');
  }
  const row = raw as Record<string, unknown>;
  return {
    makerBps: parseBpsDecimalString(row.makerBps, 'perpetual.makerBps'),
    takerBps: parseBpsDecimalString(row.takerBps, 'perpetual.takerBps'),
  };
}

/**
 * Rank discount is a fraction of the fee, floored, matching `effectiveFeeBps`.
 * 100 bps with a 5000 bps discount is 50. A zero discount leaves the published rate.
 */
export function discountedFeeBps(publishedBps: number, discountBps: number): number {
  if (!Number.isInteger(publishedBps) || publishedBps < 0 || publishedBps >= 10_000) {
    throw new FeeScheduleError(`published fee must be 0..9999 bps, got ${publishedBps}`, 'trade.fee_schedule_blank');
  }
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps >= 10_000) {
    throw new FeeScheduleError(`fee discount must be 0..9999 bps, got ${discountBps}`, 'trade.fee_schedule_blank');
  }
  const discount = Math.floor((publishedBps * discountBps) / 10_000);
  return publishedBps - discount;
}

export function previewFeeBps(schedule: OwnerFeeSchedule, role: 'maker' | 'taker', discountBps = 0): number | null {
  if (schedule.published !== true) return null;
  const published = role === 'maker' ? schedule.makerBps : schedule.takerBps;
  return discountedFeeBps(published, discountBps);
}

export type FeeProduct = 'spot' | 'perpetual';

/** Spot uses the top-level rates. Perpetual uses its own block, or refuses. */
export function publishedProductBps(schedule: OwnerFeeSchedule, product: FeeProduct): { makerBps: number; takerBps: number } | null {
  if (schedule.published !== true) return null;
  if (product === 'spot') return { makerBps: schedule.makerBps, takerBps: schedule.takerBps };
  return schedule.perpetual;
}

/**
 * Trading rates and a withdrawal network fee stay on different lines.
 * A blank trade schedule does not rewrite the network fee.
 */
export function feeScreenLines(input: { readonly schedule: OwnerFeeSchedule; readonly withdrawalNetworkFee: string }): {
  readonly trading: { readonly makerBps: number; readonly takerBps: number } | null;
  readonly withdrawalNetworkFee: string;
} {
  return {
    trading: input.schedule.published === true ? { makerBps: input.schedule.makerBps, takerBps: input.schedule.takerBps } : null,
    withdrawalNetworkFee: input.withdrawalNetworkFee,
  };
}

/**
 * Place/fill hitch. Unpublished is a typed refuse — never listing-row 10/20.
 */
export function requirePublishedFeeSchedule(schedule: OwnerFeeSchedule): Extract<OwnerFeeSchedule, { published: true }> {
  if (schedule.published !== true) {
    throw new FeeScheduleError('published fee schedule is unavailable', 'trade.fee_schedule_blank');
  }
  return schedule;
}
