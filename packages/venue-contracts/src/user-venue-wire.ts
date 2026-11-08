import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';

/**
 * The JSON form of every `UserVenue` value, for a venue reached over HTTP (the
 * TEST simulator's loopback server, svc-trade's client).
 *
 * Every `Amount` travels as its decimal string and every `Date` as its ISO
 * time (AGENTS.md floor 2). Decoding knows which fields are which by name: the
 * names below are every `Amount` and `Date` field the `UserVenue` types carry.
 * A JSON number in an `Amount` field is refused, never read as money.
 *
 * `typedData` is passed through untouched on both sides: it is the exact payload
 * the wallet signs, and the venue rebuilds and checks it at submit.
 */

const AMOUNT_FIELDS: ReadonlySet<string> = new Set([
  'amount',
  'price',
  'feeBps',
  'maxFeeBps',
  'free',
  'locked',
  'total',
  'filled',
  'remaining',
  'averagePrice',
  'venueFee',
  'builderFee',
  'realisedPnl',
  'size',
  'entryPrice',
  'markPrice',
  'unrealisedPnl',
  'margin',
  'tickSize',
  'lotSize',
  'initialMargin',
  'liquidationPrice',
  'makerFeeBps',
  'takerFeeBps',
  'fee',
  'withdrawalFee',
  // MaybeKnown<Amount>.value and AsOf<Amount>.value
  'value',
]);

/**
 * Amount fields whose name some type also uses for an object (`MaybeKnown<Amount>`, the order's `builderFee`, an
 * `AsOf` value): an object there is decoded field by field. Every other Amount field is a decimal string, never an
 * object, array or boolean.
 */
const AMOUNT_OR_OBJECT_FIELDS: ReadonlySet<string> = new Set([
  'builderFee',
  'venueFee',
  'fee',
  'withdrawalFee',
  'liquidationPrice',
  'initialMargin',
  'makerFeeBps',
  'takerFeeBps',
  'value',
]);

/** Amount fields that may be `null` (`UserVenueFill.realisedPnl`, `UserVenueOrder.averagePrice`). */
const NULLABLE_AMOUNT_FIELDS: ReadonlySet<string> = new Set(['realisedPnl', 'averagePrice']);

const DATE_FIELDS: ReadonlySet<string> = new Set(['asOf', 'preparedAt', 'filledAt', 'validUntil', 'since']);

const OPAQUE_FIELDS: ReadonlySet<string> = new Set(['typedData']);

export class VenueWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenueWireError';
  }
}

/** A `UserVenue` value as plain JSON: bigint → decimal string, Date → ISO string. */
export function encodeVenueWire(value: unknown): unknown {
  if (typeof value === 'bigint') return formatAmount(value);
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(encodeVenueWire);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    out[key] = OPAQUE_FIELDS.has(key) ? inner : encodeVenueWire(inner);
  }
  return out;
}

/** The inverse of `encodeVenueWire`. Throws `VenueWireError` on a money field that is not a decimal string. */
export function decodeVenueWire<T>(value: unknown): T {
  return decode(value, null) as T;
}

function decode(value: unknown, key: string | null): unknown {
  if (key !== null && AMOUNT_FIELDS.has(key) && !AMOUNT_OR_OBJECT_FIELDS.has(key) && typeof value !== 'string') {
    if (value === null && NULLABLE_AMOUNT_FIELDS.has(key)) return null;
    if (typeof value === 'number') throw new VenueWireError(`${key} is a JSON number; money travels as a decimal string`);
    throw new VenueWireError(
      `${key} must be a decimal string, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`,
    );
  }
  if (Array.isArray(value)) return value.map((item) => decode(item, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(value)) out[k] = OPAQUE_FIELDS.has(k) ? inner : decode(inner, k);
    return out;
  }
  if (key === null) return value;
  if (AMOUNT_FIELDS.has(key)) {
    if (typeof value === 'number') throw new VenueWireError(`${key} is a JSON number; money travels as a decimal string`);
    if (typeof value === 'string') {
      try {
        return parseAmount(value);
      } catch (err) {
        // `value` is also the field of a few non-money unions; only a decimal-looking string is read as money there.
        if (key === 'value') return value;
        throw new VenueWireError(`${key}: ${(err as Error).message}`);
      }
    }
    return value;
  }
  if (DATE_FIELDS.has(key) && typeof value === 'string') {
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw new VenueWireError(`${key} "${value}" is not a time`);
    return at;
  }
  return value;
}
