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

export type FeeScheduleErrorCode =
  | 'trade.fee_schedule_blank'
  | 'trade.fee_schedule_invalid'
  | 'trade.fee_product_unpublished'
  | 'trade.rebate_recipe_unavailable'
  | 'trade.min_fee_recipe_unavailable';

/** The tier every account sits on until a tier read says otherwise (volume tier not set → regular, the higher fee). */
export const REGULAR_FEE_TIER = 'regular' as const;

/**
 * One versioned row of the owner schedule, for one `(pairGroup, tierId)`.
 *
 * `zeroFee` and `minFee` are always explicit: a zero-fee pair says `zeroFee: true`, no minimum says `minFee: null`.
 * An absent field refuses the whole schedule rather than becoming a default.
 */
export interface FeeScheduleRow {
  readonly pairGroup: string;
  readonly tierId: string;
  readonly zeroFee: boolean;
  /** Zero when `zeroFee`. */
  readonly makerBps: number;
  readonly takerBps: number;
  /**
   * Null or 0 = no rebate. A positive rebate is paid to the maker by the ledger's `tradeFillMakerRebate`, out of the same
   * fill's taker fee: the row's maker fee must be 0 and the rebate below every taker rate in its pair group.
   */
  readonly makerRebateBps: number | null;
  /** Null = "no minimum by owner decision". A decimal-string minimum needs an amount-level fee recipe: it refuses at use. */
  readonly minFee: string | null;
  readonly effectiveAt: string | null;
}

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
      /**
       * Spot rows by pair group and tier. Absent on the flat schedule. When present, `makerBps`/`takerBps` above are
       * the default pair group's regular-tier headline and the fill path resolves the row for the market instead.
       */
      readonly rows?: readonly FeeScheduleRow[];
      /** Symbol → pair group. A symbol not listed sits in `defaultPairGroup`. */
      readonly pairGroups?: Readonly<Record<string, string>>;
      readonly defaultPairGroup?: string;
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

  const makerRebateBps = parseOptionalRebateBps(obj.makerRebateBps);
  const perpetual = parsePerpetualRates(obj.perpetual);
  const version = obj.version.trim();

  if (obj.rows !== undefined) {
    const spot = parseRowsBlock(obj);
    const headline = spot.rows.find((row) => row.pairGroup === spot.defaultPairGroup && row.tierId === REGULAR_FEE_TIER);
    if (!headline) {
      throw new FeeScheduleError(
        `${TRADE_FEE_SCHEDULE_ENV}.rows needs a '${REGULAR_FEE_TIER}' row for the default pair group '${spot.defaultPairGroup}'`,
        'trade.fee_schedule_blank',
      );
    }
    return {
      published: true,
      version,
      makerBps: headline.makerBps,
      takerBps: headline.takerBps,
      makerRebateBps,
      perpetual,
      rows: spot.rows,
      pairGroups: spot.pairGroups,
      defaultPairGroup: spot.defaultPairGroup,
    };
  }

  const makerBps = parseBpsDecimalString(obj.makerBps, 'makerBps');
  const takerBps = parseBpsDecimalString(obj.takerBps, 'takerBps');

  return {
    published: true,
    version,
    makerBps,
    takerBps,
    makerRebateBps,
    perpetual,
  };
}

const MIN_FEE_DECIMAL = /^[0-9]{1,30}(\.[0-9]{1,18})?$/;

function parseRowsBlock(obj: Record<string, unknown>): {
  rows: FeeScheduleRow[];
  pairGroups: Record<string, string>;
  defaultPairGroup: string;
} {
  const blank = (message: string) => new FeeScheduleError(`${TRADE_FEE_SCHEDULE_ENV}.${message}`, 'trade.fee_schedule_blank');
  if (obj.makerBps !== undefined || obj.takerBps !== undefined) {
    throw blank('rows replaces the flat makerBps/takerBps: give one or the other');
  }
  if (!Array.isArray(obj.rows) || obj.rows.length === 0) throw blank('rows must be a non-empty array');
  if (typeof obj.defaultPairGroup !== 'string' || !obj.defaultPairGroup.trim()) throw blank('defaultPairGroup must be a non-empty string');
  const defaultPairGroup = obj.defaultPairGroup.trim();

  const pairGroups: Record<string, string> = {};
  if (obj.pairGroups !== undefined) {
    if (!obj.pairGroups || typeof obj.pairGroups !== 'object' || Array.isArray(obj.pairGroups)) throw blank('pairGroups must be an object');
    for (const [symbol, group] of Object.entries(obj.pairGroups as Record<string, unknown>)) {
      if (typeof group !== 'string' || !group.trim()) throw blank(`pairGroups.${symbol} must be a non-empty string`);
      pairGroups[symbol] = group.trim();
    }
  }

  const seen = new Set<string>();
  const rows = obj.rows.map((raw, index): FeeScheduleRow => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw blank(`rows[${index}] must be an object`);
    const row = raw as Record<string, unknown>;
    const at = `rows[${index}]`;
    if (typeof row.pairGroup !== 'string' || !row.pairGroup.trim()) throw blank(`${at}.pairGroup must be a non-empty string`);
    if (typeof row.tierId !== 'string' || !row.tierId.trim()) throw blank(`${at}.tierId must be a non-empty string`);
    if (typeof row.zeroFee !== 'boolean') throw blank(`${at}.zeroFee must be true or false (never absent)`);
    if (!('minFee' in row)) throw blank(`${at}.minFee must be a decimal string or null (never absent)`);
    if (row.minFee !== null && (typeof row.minFee !== 'string' || !MIN_FEE_DECIMAL.test(row.minFee))) {
      throw blank(`${at}.minFee must be a decimal string or null`);
    }
    if (row.effectiveAt !== undefined && (typeof row.effectiveAt !== 'string' || Number.isNaN(Date.parse(row.effectiveAt)))) {
      throw blank(`${at}.effectiveAt must be an ISO timestamp`);
    }
    const key = `${row.pairGroup.trim()}\u0000${row.tierId.trim()}`;
    if (seen.has(key)) throw blank(`${at} repeats pairGroup/tierId ${row.pairGroup}/${row.tierId}`);
    seen.add(key);

    let makerBps = 0;
    let takerBps = 0;
    if (row.zeroFee) {
      if (row.makerBps !== undefined || row.takerBps !== undefined) throw blank(`${at}: a zeroFee row carries no makerBps/takerBps`);
    } else {
      makerBps = parseBpsDecimalString(row.makerBps, `${at}.makerBps`);
      takerBps = parseBpsDecimalString(row.takerBps, `${at}.takerBps`);
    }
    return {
      pairGroup: row.pairGroup.trim(),
      tierId: row.tierId.trim(),
      zeroFee: row.zeroFee,
      makerBps,
      takerBps,
      makerRebateBps: row.makerRebateBps === undefined ? null : parseBpsDecimalString(row.makerRebateBps, `${at}.makerRebateBps`),
      minFee: row.minFee as string | null,
      effectiveAt: typeof row.effectiveAt === 'string' ? row.effectiveAt : null,
    };
  });
  for (const row of rows) {
    if (row.makerRebateBps === null || row.makerRebateBps === 0) continue;
    const at = `rows ${row.pairGroup}/${row.tierId}`;
    if (row.zeroFee || row.makerBps !== 0) throw blank(`${at}: a maker rebate needs makerBps "0" on a row that is not zeroFee`);
    // The rebate comes out of the taker's fee on the same fill, and the taker may sit on any tier of the group.
    const lowestTaker = Math.min(...rows.filter((other) => other.pairGroup === row.pairGroup).map((other) => other.takerBps));
    if (row.makerRebateBps >= lowestTaker) {
      throw blank(`${at}: a maker rebate must be below every taker rate in its pair group (lowest ${lowestTaker})`);
    }
  }
  return { rows, pairGroups, defaultPairGroup };
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

/** Which market and tier a spot rate is for. An omitted tier is the regular tier. */
export interface FeeSelector {
  readonly symbol: string;
  readonly tierId?: string;
}

/**
 * The row a spot fill on `selector.symbol` is charged at, for a rows schedule.
 *
 * A symbol not named in `pairGroups` sits in the owner's default pair group. A missing `(group, tier)` row refuses
 * `trade.fee_schedule_blank`: a VIP tier with no row never falls back to the regular rate, and regular never to a VIP one.
 * A decimal minimum fee refuses too, because no ledger recipe takes an amount-level floor; refusing keeps the floor from
 * being silently skipped. A maker rebate is not a refusal: it is paid by its own ledger post after the fill.
 */
export function resolveFeeRow(schedule: Extract<OwnerFeeSchedule, { published: true }>, selector: FeeSelector): FeeScheduleRow | null {
  if (!schedule.rows) return null;
  const pairGroup = schedule.pairGroups?.[selector.symbol] ?? schedule.defaultPairGroup;
  const tierId = selector.tierId ?? REGULAR_FEE_TIER;
  const row = schedule.rows.find((candidate) => candidate.pairGroup === pairGroup && candidate.tierId === tierId);
  if (!row) {
    logRefusalSpec('trade.fee_schedule_blank');
    throw new FeeScheduleError(
      `${TRADE_FEE_SCHEDULE_ENV} has no row for pair group '${pairGroup}' tier '${tierId}'`,
      'trade.fee_schedule_blank',
    );
  }
  if (row.minFee !== null) {
    logRefusalSpec('trade.min_fee_recipe_unavailable');
    throw new FeeScheduleError(
      'A minimum fee needs a ledger recipe that takes a fee amount; tradeFill takes basis points only',
      'trade.min_fee_recipe_unavailable',
      'A minimum fee is not available yet: the ledger fill recipe charges by rate only.',
    );
  }
  return row;
}

export function previewFeeBps(schedule: OwnerFeeSchedule, role: 'maker' | 'taker', discountBps = 0, selector?: FeeSelector): number | null {
  if (schedule.published !== true) return null;
  const row = selector ? resolveFeeRow(schedule, selector) : null;
  const published = row ? (role === 'maker' ? row.makerBps : row.takerBps) : role === 'maker' ? schedule.makerBps : schedule.takerBps;
  return discountedFeeBps(published, discountBps);
}

export type FeeProduct = 'spot' | 'perpetual';

/**
 * The maker rebate a spot fill's maker earns on its row, in bps of what the maker paid; 0 when the row publishes none.
 * Only a rows schedule pays one: the flat schedule's `makerRebateBps` was never paid and the public schedule marks it.
 */
export function makerRebateBpsFor(schedule: OwnerFeeSchedule, selector: FeeSelector): number {
  if (schedule.published !== true || !schedule.rows) return 0;
  return resolveFeeRow(schedule, selector)?.makerRebateBps ?? 0;
}

/**
 * The rebate one fill pays: the maker's published rate, held below the taker rate this fill actually charges (a rank
 * discount can bring a taker under the rebate), because the ledger pays it out of that same taker fee. 0 = none.
 */
export function fundedMakerRebateBps(makerRebateBps: number, makerFeeBps: number, takerFeeBps: number): number {
  if (makerRebateBps <= 0 || makerFeeBps !== 0 || takerFeeBps <= 1) return 0;
  return Math.min(makerRebateBps, takerFeeBps - 1);
}

/** Spot uses the top-level rates. Perpetual uses its own block, or refuses. */
export function publishedProductBps(
  schedule: OwnerFeeSchedule,
  product: FeeProduct,
  selector?: FeeSelector,
): { makerBps: number; takerBps: number } | null {
  if (schedule.published !== true) return null;
  if (product === 'spot') {
    const row = selector ? resolveFeeRow(schedule, selector) : null;
    return row ? { makerBps: row.makerBps, takerBps: row.takerBps } : { makerBps: schedule.makerBps, takerBps: schedule.takerBps };
  }
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
    logRefusalSpec('trade.fee_schedule_blank');
    throw new FeeScheduleError('Trading fees are not available yet: the maker and taker schedule is not set.', 'trade.fee_schedule_blank');
  }
  return schedule;
}

/** One tier's published spot rates in one pair group, as the public schedule shows them. */
export interface PublicFeeRow {
  readonly tierId: string;
  readonly zeroFee: boolean;
  readonly makerBps: number;
  readonly takerBps: number;
  readonly makerRebateBps: number | null;
  /** Absent on the flat schedule, which publishes no minimum either way. */
  readonly minFee?: string | null;
  /**
   * Set when an order on this row is refused although the row is published: a minimum fee that no ledger recipe can
   * post (`resolveFeeRow`), or the flat schedule's rebate, which is never paid. A page shows the row as not available,
   * never as a rate anyone pays.
   */
  readonly refusal?: 'trade.rebate_recipe_unavailable' | 'trade.min_fee_recipe_unavailable';
}

/** The code `resolveFeeRow` refuses a published row with, or undefined when the row can be charged. */
function rowRefusal(row: FeeScheduleRow): PublicFeeRow['refusal'] {
  if (row.minFee !== null) return 'trade.min_fee_recipe_unavailable';
  return undefined;
}

/** One pair group: the listed spot markets in it and the tiers the owner published a row for. */
export interface PublicFeeGroup {
  readonly pairGroup: string;
  /** The group every symbol not named in `pairGroups` sits in. */
  readonly isDefault: boolean;
  readonly symbols: readonly string[];
  readonly rows: readonly PublicFeeRow[];
}

/** The flat schedule's one group: every listed market at the regular tier. */
export const FLAT_PAIR_GROUP = 'all' as const;

/**
 * The published spot schedule by pair group and tier, for the public fee page and the fee API.
 *
 * Every group the owner named appears, even one with no rows at all, so a page can say "not set" for a tier the owner
 * left blank instead of leaving the group out. `tiers` lists every tier any group publishes, regular first. Nothing is
 * resolved or defaulted here: a missing `(group, tier)` row is simply absent from that group's rows.
 */
export function publicFeeSchedule(
  schedule: Extract<OwnerFeeSchedule, { published: true }>,
  spotSymbols: readonly string[],
): { readonly groups: readonly PublicFeeGroup[]; readonly tiers: readonly string[] } {
  if (!schedule.rows || !schedule.defaultPairGroup) {
    return {
      groups: [
        {
          pairGroup: FLAT_PAIR_GROUP,
          isDefault: true,
          symbols: [...spotSymbols],
          rows: [
            {
              tierId: REGULAR_FEE_TIER,
              zeroFee: false,
              makerBps: schedule.makerBps,
              takerBps: schedule.takerBps,
              makerRebateBps: schedule.makerRebateBps,
              ...(schedule.makerRebateBps !== null && schedule.makerRebateBps > 0 ? { refusal: 'trade.rebate_recipe_unavailable' as const } : {}),
            },
          ],
        },
      ],
      tiers: [REGULAR_FEE_TIER],
    };
  }
  const defaultGroup = schedule.defaultPairGroup;
  const groupOf = (symbol: string) => schedule.pairGroups?.[symbol] ?? defaultGroup;
  const names = [defaultGroup, ...schedule.rows.map((row) => row.pairGroup), ...Object.values(schedule.pairGroups ?? {})];
  const groups = [...new Set(names)].map((pairGroup): PublicFeeGroup => ({
    pairGroup,
    isDefault: pairGroup === defaultGroup,
    symbols: spotSymbols.filter((symbol) => groupOf(symbol) === pairGroup),
    rows: schedule
      .rows!.filter((row) => row.pairGroup === pairGroup)
      .map((row) => {
        const refusal = rowRefusal(row);
        const { tierId, zeroFee, makerBps, takerBps, makerRebateBps, minFee } = row;
        return { tierId, zeroFee, makerBps, takerBps, makerRebateBps, minFee, ...(refusal ? { refusal } : {}) };
      }),
  }));
  const tiers = [...new Set([REGULAR_FEE_TIER, ...schedule.rows.map((row) => row.tierId)])];
  return { groups, tiers };
}
