import type { MarketRow } from './reads';
import type { RiskCurrent, RiskLimitValues } from './desk-parse';
import { BLOCKERS } from './blockers';
import { blocked, refused, type Outcome } from './outcome';

/**
 * Pure rules for the Risk limits room: which limits are readable per market, which engine checks exist but
 * cannot be read, and the validation of a limit edit (decimal strings against the market's tick and lot rules,
 * done with BigInt on a scaled value, never floats). No network here.
 */

export type LimitField = 'tickSize' | 'lotSize' | 'minQty' | 'maxQty' | 'minNotional' | 'makerBps' | 'takerBps';

export interface LimitFieldInfo {
  readonly field: LimitField;
  readonly label: string;
  /** What the value means, one line. */
  readonly meaning: string;
  readonly kind: 'decimal' | 'bps';
}

export const LIMIT_FIELDS: readonly LimitFieldInfo[] = [
  { field: 'tickSize', label: 'Tick size', meaning: 'Smallest price step. Order prices must be a multiple of it.', kind: 'decimal' },
  { field: 'lotSize', label: 'Lot size', meaning: 'Smallest quantity step. Order quantities must be a multiple of it.', kind: 'decimal' },
  { field: 'minQty', label: 'Min quantity', meaning: 'Smallest order quantity. A multiple of the lot size.', kind: 'decimal' },
  {
    field: 'maxQty',
    label: 'Max quantity',
    meaning: 'Largest order quantity. A multiple of the lot size, not below min quantity.',
    kind: 'decimal',
  },
  { field: 'minNotional', label: 'Min notional', meaning: 'Smallest order value (price x quantity) in the quote asset.', kind: 'decimal' },
  {
    field: 'makerBps',
    label: 'Listing maker fee (bps)',
    meaning: 'Listing metadata, not charged. Customers pay the owner fee schedule shown above.',
    kind: 'bps',
  },
  {
    field: 'takerBps',
    label: 'Listing taker fee (bps)',
    meaning: 'Listing metadata, not charged. Customers pay the owner fee schedule shown above.',
    kind: 'bps',
  },
];

/**
 * The operator limits svc-trade enforces on the order path: five on every market, plus what a futures order reads: the
 * open-interest pair and the dynamic price range. Blank means unset: a check does nothing (an open-interest limit
 * refuses every futures open, and a blank range leaves the static band) and no number is invented.
 */
export type OperatorLimitField = keyof RiskLimitValues;

export interface EngineCheck {
  readonly id: string;
  readonly field: OperatorLimitField;
  readonly name: string;
  readonly what: string;
  /** How the value is written, one line. */
  readonly unit: string;
  readonly kind: 'decimal' | 'integer';
  /**
   * Read by the futures order path only. On other markets the room shows it as not applying and never sends it, so the
   * service keeps whatever it holds.
   */
  readonly futuresOnly?: true;
}

export const ENGINE_CHECKS: readonly EngineCheck[] = [
  {
    id: 'price_collar',
    field: 'collar',
    name: 'Price band',
    what: 'Refuses a buy priced above, or a sell priced below, this fraction around the middle of the best bid and ask. With no bid or ask on the book there is no band, since an order there cannot trade against anything. A bracket’s stop for a filled entry is never refused.',
    unit: 'A fraction of the price: 0.1 is 10%.',
    kind: 'decimal',
  },
  {
    id: 'fat_finger',
    field: 'fatFinger',
    name: 'Fat-finger check',
    what: 'Refuses an order whose value (price x quantity) is above this limit, in the quote asset.',
    unit: 'Decimal, up to 18 places.',
    kind: 'decimal',
  },
  {
    id: 'slippage_cap',
    field: 'slippageCap',
    name: 'Slippage cap',
    what: 'Caps how far a market order may walk the book.',
    unit: 'Whole basis points, 1 to 5000.',
    kind: 'integer',
  },
  {
    id: 'message_throttle',
    field: 'throttle',
    name: 'Open-order cap',
    what: 'Refuses a new order that would rest when the account already has this many open on the market. Market, IOC and FOK orders do not count.',
    unit: 'Whole number.',
    kind: 'integer',
  },
  {
    id: 'circuit_breaker',
    field: 'circuitBreaker',
    name: 'Circuit breaker',
    what: 'Pauses a market after a large price move. While set, the order path refuses new orders on the market, because it has no reference mark to judge a move against.',
    unit: 'Whole number.',
    kind: 'integer',
  },
  {
    id: 'open_interest_limit',
    field: 'oiLimit',
    name: 'Open-interest limit',
    what: 'The most open interest the market may carry: open positions plus what live opening orders can still fill. An open past it is refused with the room left. While blank, every futures open on the market is refused. Closing is never refused.',
    unit: 'In the base asset, up to 18 places.',
    kind: 'decimal',
    futuresOnly: true,
  },
  {
    id: 'open_interest_share',
    field: 'oiShareBps',
    name: 'Open-interest share per account',
    what: 'The largest part of the open-interest limit one account may hold. An open past it is refused with the room left. While blank, every futures open on the market is refused.',
    unit: 'Whole basis points, 1 to 10000: 1000 is 10%.',
    kind: 'integer',
    futuresOnly: true,
  },
  {
    id: 'price_range_max',
    field: 'priceRangeMax',
    name: 'Price range: widest band',
    what: 'While the futures price trades away from the mark, new orders may be priced inside a band wider than the usual one, but never wider than this. Resting orders keep the band they were accepted under. Set with the trigger and the cadence; with all three blank the band is the usual one.',
    unit: 'A fraction of the mark above 0 and below 1: 0.2 is 20%.',
    kind: 'decimal',
    futuresOnly: true,
  },
  {
    id: 'price_range_trigger',
    field: 'priceRangeTrigger',
    name: 'Price range: trigger',
    what: 'How far the middle of the futures book must be from the mark before the band widens. Past it, the band is the usual one plus that distance.',
    unit: 'A fraction of the mark, 0 up to below 1: 0.01 is 1%.',
    kind: 'decimal',
    futuresOnly: true,
  },
  {
    id: 'price_range_cadence',
    field: 'priceRangeCadenceSeconds',
    name: 'Price range: cadence',
    what: 'How often the band is worked out again. A band not worked out within two cadences (or two runs of the futures jobs, when those are slower) falls back to the usual one.',
    unit: 'Whole seconds, 1 to 86400.',
    kind: 'integer',
    futuresOnly: true,
  },
];

/** The three values of the dynamic price range: all set, or all blank. */
export const PRICE_RANGE_FIELDS = ['priceRangeMax', 'priceRangeTrigger', 'priceRangeCadenceSeconds'] as const;

/** Whether a check applies to a market of this kind, so the room offers and sends it there. */
export function appliesTo(check: EngineCheck, kind: MarketRow['kind'] | undefined): boolean {
  return !check.futuresOnly || kind === 'futures';
}

/** The form values to send for a market of this kind: a check that does not apply is left out, never sent blank. */
export function valuesFor(
  values: Readonly<Record<OperatorLimitField, string>>,
  kind: MarketRow['kind'] | undefined,
): Partial<Record<OperatorLimitField, string>> {
  return Object.fromEntries(ENGINE_CHECKS.filter((c) => appliesTo(c, kind)).map((c) => [c.field, values[c.field]]));
}

const LIMIT_DEC = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const LIMIT_INT = /^(?:0|[1-9]\d*)$/;
/** The ledger's amount column holds below 10^20 whole units at 18 places, so a longer whole part cannot be stored. */
const LEDGER_WHOLE_DIGITS = 20;

type FuturesOnlyField = 'oiLimit' | 'oiShareBps' | (typeof PRICE_RANGE_FIELDS)[number];
/**
 * What `admin.risk.set` takes: the five limits always, and the futures-only values only when they are sent. One left out
 * keeps its current value, so a form or approval that never knew of it cannot clear it.
 */
export type RiskLimitsWrite = Omit<RiskLimitValues, FuturesOnlyField> & Partial<Pick<RiskLimitValues, FuturesOnlyField>>;

/** Above 0 and below 1, up to 18 places. */
const FRACTION_BELOW_ONE = /^0\.\d{1,18}$/;

/** The write svc-trade `admin.risk.set` takes, once the form has checked it. */
export interface RiskSetBody {
  readonly market: string;
  readonly limits: RiskLimitsWrite;
  readonly expectedVersion: string;
  readonly reason: string;
}

export type RiskSetCheck =
  { readonly ok: true; readonly body: RiskSetBody } | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Check a change to the operator limits of one market against the version the desk read. A blank field is unset (null);
 * nothing is filled in. A missing one of the five is blank too; a missing futures-only field is left out of the write,
 * so the service keeps it. Mirrors the service's own rules so a bad value is refused here, with the same words, before a
 * proposal is made. The service checks again.
 */
export function checkRiskSet(
  current: RiskCurrent,
  values: Readonly<Partial<Record<OperatorLimitField, string>>>,
  reasonInput: unknown,
): RiskSetCheck {
  const next: Partial<Record<OperatorLimitField, string | null>> = {};
  for (const check of ENGINE_CHECKS) {
    const sent = values[check.field];
    if (sent === undefined && check.futuresOnly) continue;
    const raw = (sent ?? '').trim();
    next[check.field] = null;
    if (raw === '') continue;
    const good = check.kind === 'decimal' ? LIMIT_DEC.test(raw) : LIMIT_INT.test(raw);
    if (!good) return { ok: false, code: 'risk_limits.bad_value', message: `${check.name}: ${check.unit} No signs, exponents or spaces.` };
    if (check.field === 'slippageCap' && (Number(raw) < 1 || Number(raw) > 5000))
      return { ok: false, code: 'risk_limits.bad_value', message: 'Slippage cap must be a whole number of basis points from 1 to 5000.' };
    if (check.field === 'oiShareBps' && (Number(raw) < 1 || Number(raw) > 10_000))
      return {
        ok: false,
        code: 'risk_limits.bad_value',
        message: 'Open-interest share must be a whole number of basis points from 1 to 10000.',
      };
    if (check.field === 'oiLimit' && raw.split('.')[0]!.length > LEDGER_WHOLE_DIGITS)
      return {
        ok: false,
        code: 'risk_limits.bad_value',
        message: `Open-interest limit must have at most ${LEDGER_WHOLE_DIGITS} digits before the point.`,
      };
    if (check.field === 'priceRangeMax' && !(FRACTION_BELOW_ONE.test(raw) && /[1-9]/.test(raw)))
      return {
        ok: false,
        code: 'risk_limits.bad_value',
        message: 'Price range widest band must be a fraction of the mark above 0 and below 1, for example 0.2.',
      };
    if (check.field === 'priceRangeTrigger' && !(raw === '0' || FRACTION_BELOW_ONE.test(raw)))
      return {
        ok: false,
        code: 'risk_limits.bad_value',
        message: 'Price range trigger must be a fraction of the mark from 0 up to below 1, for example 0.01.',
      };
    if (check.field === 'priceRangeCadenceSeconds' && (Number(raw) < 1 || Number(raw) > 86_400))
      return {
        ok: false,
        code: 'risk_limits.bad_value',
        message: 'Price range cadence must be a whole number of seconds from 1 to 86400.',
      };
    next[check.field] = raw;
  }
  // The range only works whole: as it would stand after this write (a value left out keeps the current one).
  const range = PRICE_RANGE_FIELDS.map((f) => (next[f] === undefined ? current[f] : next[f]));
  const rangeSet = range.filter((v) => v !== null).length;
  if (rangeSet !== 0 && rangeSet !== PRICE_RANGE_FIELDS.length)
    return {
      ok: false,
      code: 'risk_limit_not_exact',
      message: 'The price range is the widest band, the trigger and the cadence together: set all three, or clear all three.',
    };
  const unchanged = ENGINE_CHECKS.every((c) => next[c.field] === undefined || next[c.field] === current[c.field]);
  if (unchanged) return { ok: false, code: 'risk_limits.no_change', message: 'These are already the current limits.' };
  const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
  if (reason.length < 12 || reason.length > 500)
    return { ok: false, code: 'risk_limits.bad_reason', message: 'The reason must be 12 to 500 characters; it is kept in the audit.' };
  return { ok: true, body: { market: current.marketId, limits: next as RiskLimitsWrite, expectedVersion: current.version, reason } };
}

/** The text of each limit as the form shows it: unset is an empty box, never a zero. */
export function limitText(value: string | null): string {
  return value ?? '';
}

export const FUTURES_NOTE =
  'The open-interest limit, the per-account share and the dynamic price range are set with the operator limits on a futures market. With either open-interest value blank, every futures open on that market is refused; with the price range blank, new orders keep the usual band. On other markets they are shown as not applying. Auto-deleveraging (ADL) and the insurance fund have no operator controls in this room.';

// ── exact decimal helpers (BigInt, no floats) ────────────────────────────────

const DEC = /^\d+(\.\d+)?$/;
const INT = /^\d+$/;

function scaleOf(s: string): number {
  return s.split('.')[1]?.length ?? 0;
}

/** Both strings as integers on the same scale. */
function align(a: string, b: string): [bigint, bigint] {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  const big = (s: string) => {
    const [i = '0', f = ''] = s.split('.');
    return BigInt(i + f.padEnd(scale, '0'));
  };
  return [big(a), big(b)];
}

export function isPositiveDecimal(s: string): boolean {
  if (!DEC.test(s)) return false;
  const [v] = align(s, '0');
  return v > 0n;
}

/** True when `value` is a whole multiple of `step` (step must be positive). */
export function isMultipleOf(value: string, step: string): boolean {
  if (!DEC.test(value) || !isPositiveDecimal(step)) return false;
  const [v, s] = align(value, step);
  return v % s === 0n;
}

/** a >= b as exact decimals. */
export function decimalGte(a: string, b: string): boolean {
  const [x, y] = align(a, b);
  return x >= y;
}

export function isLimitField(v: unknown): v is LimitField {
  return typeof v === 'string' && LIMIT_FIELDS.some((f) => f.field === v);
}

export function currentValue(market: MarketRow, field: LimitField): string | null {
  switch (field) {
    case 'tickSize':
      return market.tickSize;
    case 'lotSize':
      return market.lotSize;
    case 'minQty':
      return market.minQty;
    case 'maxQty':
      return market.maxQty;
    case 'minNotional':
      return market.minNotional;
    case 'makerBps':
      return String(market.makerBps);
    case 'takerBps':
      return String(market.takerBps);
  }
}

export interface LimitEditInput {
  readonly symbol: string;
  readonly field: LimitField;
  readonly value: string;
  readonly reason: string;
  readonly secondApproverId: string;
}

export type LimitCheck =
  { readonly ok: true; readonly edit: LimitEditInput } | { readonly ok: false; readonly code: string; readonly message: string };

export const BPS_MAX = 10_000;

/**
 * Validate an edit against the market's own tick/lot rules. `markets` is what the desk last read; an edit for a
 * symbol that is not in it is refused rather than guessed.
 */
export function checkLimitEdit(input: Record<string, unknown>, markets: readonly MarketRow[], signedInUserId: string): LimitCheck {
  const symbol = typeof input.symbol === 'string' ? input.symbol : '';
  const market = markets.find((m) => m.symbol === symbol);
  if (!market) return { ok: false, code: 'risk_limits.unknown_market', message: 'Choose a market from the list the desk read.' };
  if (!isLimitField(input.field)) return { ok: false, code: 'risk_limits.unknown_field', message: 'Choose which limit to change.' };
  const info = LIMIT_FIELDS.find((f) => f.field === input.field) as LimitFieldInfo;
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  const field = input.field;

  if (info.kind === 'bps') {
    if (!INT.test(value) || BigInt(value) > BigInt(BPS_MAX))
      return { ok: false, code: 'risk_limits.bad_value', message: `${info.label} must be a whole number from 0 to ${BPS_MAX}.` };
  } else {
    if (!isPositiveDecimal(value))
      return {
        ok: false,
        code: 'risk_limits.bad_value',
        message: `${info.label} must be a decimal greater than zero, written as digits with an optional fraction (for example 0.01).`,
      };
    const lot = field === 'lotSize' ? value : market.lotSize;
    if (field === 'minQty' || field === 'maxQty') {
      if (!isMultipleOf(value, market.lotSize))
        return {
          ok: false,
          code: 'risk_limits.not_lot_multiple',
          message: `${info.label} must be a multiple of the lot size ${market.lotSize}.`,
        };
    }
    if (field === 'lotSize') {
      if (!isMultipleOf(market.minQty, lot))
        return {
          ok: false,
          code: 'risk_limits.not_lot_multiple',
          message: `The current min quantity ${market.minQty} would not be a multiple of lot size ${value}.`,
        };
      if (market.maxQty !== null && !isMultipleOf(market.maxQty, lot))
        return {
          ok: false,
          code: 'risk_limits.not_lot_multiple',
          message: `The current max quantity ${market.maxQty} would not be a multiple of lot size ${value}.`,
        };
    }
    if (field === 'minQty' && market.maxQty !== null && !decimalGte(market.maxQty, value))
      return { ok: false, code: 'risk_limits.min_above_max', message: `Min quantity cannot be above the max quantity ${market.maxQty}.` };
    if (field === 'maxQty' && !decimalGte(value, market.minQty))
      return { ok: false, code: 'risk_limits.min_above_max', message: `Max quantity cannot be below the min quantity ${market.minQty}.` };
  }
  if (value === currentValue(market, field))
    return { ok: false, code: 'risk_limits.no_change', message: 'That is already the current value.' };
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 12 || reason.length > 500)
    return { ok: false, code: 'risk_limits.bad_reason', message: 'The reason must be 12 to 500 characters; it is kept in the audit.' };
  const secondApproverId = typeof input.secondApproverId === 'string' ? input.secondApproverId.trim() : '';
  if (secondApproverId === '') return { ok: false, code: 'missing_operator', message: 'A second approver is required for a limit change.' };
  if (secondApproverId === signedInUserId.trim())
    return { ok: false, code: 'missing_operator', message: 'The second approver must be a different operator than you.' };
  return { ok: true, edit: { symbol, field, value, reason, secondApproverId } };
}

/** The handler's whole answer today: validated, then the typed blocker. Nothing is sent. */
export function limitEditOutcome(input: Record<string, unknown>, markets: readonly MarketRow[], signedInUserId: string): Outcome<never> {
  const c = checkLimitEdit(input, markets, signedInUserId);
  return c.ok ? blocked(BLOCKERS.market_rules_no_operator_api) : refused(c.code, c.message, 400);
}
