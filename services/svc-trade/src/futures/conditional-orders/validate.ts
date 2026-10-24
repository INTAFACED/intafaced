/**
 * Field law for a futures conditional order.
 *
 * A kind the service cannot honour, or a field that kind does not use, refuses
 * before a row is written. Prices are decimal strings. A number is not accepted
 * and nothing here turns one into a price.
 */
import { createHash } from 'node:crypto';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { FuturesError } from '../position-service.js';

export const CONDITIONAL_KINDS = ['stop_market', 'stop_limit', 'take_profit', 'trailing_stop'] as const;
export type ConditionalKind = (typeof CONDITIONAL_KINDS)[number];
export type ConditionalSide = 'buy' | 'sell';
export type ConditionalStatus = 'armed' | 'triggered' | 'filled' | 'cancelled' | 'failed';
export type AttachmentLeg = 'take_profit' | 'stop_loss';
/** The price a trigger is judged on: the published mark, or the futures book's last trade. */
export type TriggerSource = 'mark' | 'last';

export interface ParsedConditional {
  readonly market: string;
  readonly kind: ConditionalKind;
  readonly side: ConditionalSide;
  readonly quantity: Amount;
  readonly triggerPrice: Amount | null;
  readonly limitPrice: Amount | null;
  readonly trailingDistance: Amount | null;
  readonly reduceOnly: true;
  readonly clientOrderId: string;
  readonly triggerSource: TriggerSource;
}

export interface CreateConditionalInput {
  readonly market: unknown;
  readonly kind: unknown;
  readonly side: unknown;
  readonly quantity: unknown;
  readonly triggerPrice?: unknown;
  readonly limitPrice?: unknown;
  readonly trailingDistance?: unknown;
  readonly reduceOnly?: unknown;
  readonly clientOrderId: unknown;
  readonly triggerSource?: unknown;
}

const FIELD_REQUIRED = 'trade.conditional_field_required';
const FIELD_UNSUPPORTED = 'trade.conditional_field_unsupported';
const AMOUNT_INVALID = 'trade.conditional_amount_invalid';

function isKind(value: unknown): value is ConditionalKind {
  return typeof value === 'string' && (CONDITIONAL_KINDS as readonly string[]).includes(value);
}

function parseDecimal(field: string, raw: string): Amount {
  try {
    const amount = parseAmount(raw);
    if (amount <= 0n) throw new Error('non-positive');
    return amount;
  } catch (err) {
    if (err instanceof FuturesError) throw err;
    throw new FuturesError(`${field} must be a positive decimal string`, AMOUNT_INVALID, 400);
  }
}

function decimalField(field: string, raw: unknown, mode: 'required' | 'forbidden'): Amount | null {
  const missing = raw === undefined || raw === null;
  if (mode === 'forbidden') {
    if (!missing) {
      throw new FuturesError(`${field} is not used for this kind`, FIELD_UNSUPPORTED, 400);
    }
    return null;
  }
  if (missing) throw new FuturesError(`${field} is required`, FIELD_REQUIRED, 400);
  if (typeof raw !== 'string') throw new FuturesError(`${field} must be a decimal string`, FIELD_UNSUPPORTED, 400);
  return parseDecimal(field, raw);
}

export function requireClientKey(raw: unknown, field: string, code: string): string {
  if (typeof raw !== 'string') throw new FuturesError(`${field} is required (1–64 chars)`, code, 400);
  const id = raw.trim();
  if (id.length < 1 || id.length > 64) throw new FuturesError(`${field} is required (1–64 chars)`, code, 400);
  return id;
}

/** Refuse a kind or a field this service cannot store. Does not read a position. */
export function validateConditional(input: CreateConditionalInput): ParsedConditional {
  if (typeof input.market !== 'string' || input.market.trim() === '') {
    throw new FuturesError('market is required', FIELD_REQUIRED, 400);
  }
  if (!isKind(input.kind)) {
    throw new FuturesError('conditional kind is not supported', 'trade.conditional_kind_unsupported', 400);
  }
  if (input.side !== 'buy' && input.side !== 'sell') {
    throw new FuturesError('side must be buy or sell', FIELD_REQUIRED, 400);
  }
  const quantity = decimalField('quantity', input.quantity, 'required');
  const clientOrderId = requireClientKey(input.clientOrderId, 'clientOrderId', 'trade.client_order_id_required');
  if (input.reduceOnly === false) {
    throw new FuturesError('a conditional exit cannot open or enlarge a position', 'trade.conditional_reduce_only_required', 400);
  }
  if (input.reduceOnly !== undefined && input.reduceOnly !== true) {
    throw new FuturesError('reduceOnly must be true when it is sent', FIELD_UNSUPPORTED, 400);
  }

  const triggerSource = parseTriggerSource(input.triggerSource);
  const triggerMode = input.kind === 'trailing_stop' ? 'forbidden' : 'required';
  const limitMode = input.kind === 'stop_limit' ? 'required' : 'forbidden';
  const trailMode = input.kind === 'trailing_stop' ? 'required' : 'forbidden';
  return {
    market: input.market.trim(),
    kind: input.kind,
    side: input.side,
    quantity: quantity!,
    triggerPrice: decimalField('triggerPrice', input.triggerPrice, triggerMode),
    limitPrice: decimalField('limitPrice', input.limitPrice, limitMode),
    trailingDistance: decimalField('trailingDistance', input.trailingDistance, trailMode),
    reduceOnly: true,
    clientOrderId,
    triggerSource,
  };
}

/**
 * Absent is the mark. The index is a source this deployment does not publish (an outside feed), so a trigger judged on
 * it would never fire: it is refused by name rather than stored.
 */
function parseTriggerSource(raw: unknown): TriggerSource {
  if (raw === undefined || raw === null || raw === 'mark') return 'mark';
  if (raw === 'last') return 'last';
  if (raw === 'index') {
    // The same code spot answers for a trigger source with no published feed (placement-options.ts).
    throw new FuturesError(
      'the index price is not published on this deployment, so a trigger cannot be judged on it',
      'trade.trigger_source_unset',
      400,
    );
  }
  throw new FuturesError('triggerSource must be mark, last or index', 'trade.trigger_source_unsupported', 400);
}

export function requestHash(parts: Readonly<Record<string, string>>): string {
  const body = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key]}`)
    .join('\n');
  return createHash('sha256').update(body).digest('hex');
}

export function conditionalHash(order: ParsedConditional): string {
  return requestHash({
    market: order.market,
    kind: order.kind,
    side: order.side,
    quantity: formatAmount(order.quantity),
    triggerPrice: order.triggerPrice == null ? '' : formatAmount(order.triggerPrice),
    limitPrice: order.limitPrice == null ? '' : formatAmount(order.limitPrice),
    trailingDistance: order.trailingDistance == null ? '' : formatAmount(order.trailingDistance),
    reduceOnly: 'true',
    // A mark-judged order hashes as it always has, so a retry sent before trigger sources existed still replays.
    ...(order.triggerSource !== 'mark' ? { triggerSource: order.triggerSource } : {}),
  });
}

/**
 * Take-profit fires through the favourable side of the trigger.
 * A stop, a stop-limit, and a trailing stop fire through the adverse side.
 */
export function triggerCrossed(input: {
  readonly kind: ConditionalKind;
  readonly side: ConditionalSide;
  readonly mark: Amount;
  readonly trigger: Amount;
}): boolean {
  const takeProfit = input.kind === 'take_profit';
  if (input.side === 'sell') return takeProfit ? input.mark >= input.trigger : input.mark <= input.trigger;
  return takeProfit ? input.mark <= input.trigger : input.mark >= input.trigger;
}

/**
 * A sell trail's extreme only rises. A buy trail's extreme only falls.
 * The trigger is recomputed from that extreme. A mark the other way does not move it.
 */
export function nextTrail(input: {
  readonly side: ConditionalSide;
  readonly extreme: Amount;
  readonly mark: Amount;
  readonly distance: Amount;
}): { readonly extreme: Amount; readonly trigger: Amount; readonly moved: boolean } {
  let extreme = input.extreme;
  let moved = false;
  if (input.side === 'sell' && input.mark > extreme) {
    extreme = input.mark;
    moved = true;
  } else if (input.side === 'buy' && input.mark < extreme) {
    extreme = input.mark;
    moved = true;
  }
  const trigger = (input.side === 'sell' ? extreme - input.distance : extreme + input.distance) as Amount;
  return { extreme, trigger, moved };
}

export function closingSide(positionSide: 'long' | 'short'): ConditionalSide {
  return positionSide === 'long' ? 'sell' : 'buy';
}

/** Strict. A price sitting on the mark is the wrong side — it is not a protective distance. */
export function priceOnProtectionSide(input: {
  readonly positionSide: 'long' | 'short';
  readonly leg: AttachmentLeg;
  readonly mark: Amount;
  readonly price: Amount;
}): boolean {
  if (input.positionSide === 'long') {
    return input.leg === 'take_profit' ? input.price > input.mark : input.price < input.mark;
  }
  return input.leg === 'take_profit' ? input.price < input.mark : input.price > input.mark;
}
