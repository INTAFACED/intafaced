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

/** The five operator limits svc-trade enforces on the order path. Blank means unset: the check does nothing and no number is invented. */
export type OperatorLimitField = keyof RiskLimitValues;

export interface EngineCheck {
  readonly id: string;
  readonly field: OperatorLimitField;
  readonly name: string;
  readonly what: string;
  /** How the value is written, one line. */
  readonly unit: string;
  readonly kind: 'decimal' | 'integer';
}

export const ENGINE_CHECKS: readonly EngineCheck[] = [
  {
    id: 'price_collar',
    field: 'collar',
    name: 'Price collar',
    what: 'Refuses an order priced too far from a reference price.',
    unit: 'Decimal, up to 18 places.',
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
    name: 'Message throttle',
    what: 'Limits how many orders or cancels one account may send in a period.',
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
];

const LIMIT_DEC = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const LIMIT_INT = /^(?:0|[1-9]\d*)$/;

/** The write svc-trade `admin.risk.set` takes, once the form has checked it. */
export interface RiskSetBody {
  readonly market: string;
  readonly limits: RiskLimitValues;
  readonly expectedVersion: string;
  readonly reason: string;
}

export type RiskSetCheck =
  { readonly ok: true; readonly body: RiskSetBody } | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Check a change to the operator limits of one market against the version the desk read. A blank field is unset (null);
 * nothing is filled in. Mirrors the service's own rules so a bad value is refused here, with the same words, before a
 * proposal is made. The service checks again.
 */
export function checkRiskSet(
  current: RiskCurrent,
  values: Readonly<Record<OperatorLimitField, string>>,
  reasonInput: unknown,
): RiskSetCheck {
  const next: Record<OperatorLimitField, string | null> = {
    collar: null,
    fatFinger: null,
    slippageCap: null,
    throttle: null,
    circuitBreaker: null,
  };
  for (const check of ENGINE_CHECKS) {
    const raw = (values[check.field] ?? '').trim();
    if (raw === '') continue;
    const good = check.kind === 'decimal' ? LIMIT_DEC.test(raw) : LIMIT_INT.test(raw);
    if (!good) return { ok: false, code: 'risk_limits.bad_value', message: `${check.name}: ${check.unit} No signs, exponents or spaces.` };
    if (check.field === 'slippageCap' && (Number(raw) < 1 || Number(raw) > 5000))
      return { ok: false, code: 'risk_limits.bad_value', message: 'Slippage cap must be a whole number of basis points from 1 to 5000.' };
    next[check.field] = raw;
  }
  const unchanged = ENGINE_CHECKS.every((c) => next[c.field] === current[c.field]);
  if (unchanged) return { ok: false, code: 'risk_limits.no_change', message: 'These are already the current limits.' };
  const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
  if (reason.length < 12 || reason.length > 500)
    return { ok: false, code: 'risk_limits.bad_reason', message: 'The reason must be 12 to 500 characters; it is kept in the audit.' };
  return { ok: true, body: { market: current.marketId, limits: next, expectedVersion: current.version, reason } };
}

/** The text of each limit as the form shows it: unset is an empty box, never a zero. */
export function limitText(value: string | null): string {
  return value ?? '';
}

export const FUTURES_NOTE =
  'Futures limits, auto-deleveraging (ADL) and the insurance fund are not shown: futures are switched off (TRADE_FUTURES_ENABLED stays off), so there is nothing to read or change. Operator controls for them are not built.';

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
