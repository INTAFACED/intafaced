/**
 * ix-wire.js — THE RESPONSE CONTRACT FOR THE SHIPPING SHELL.
 *
 * WHAT THIS REPLACES. `apps/web/src/lib/api/wire.ts` was the runtime contract
 * that protected the old frontend: every response was parsed against a zod
 * schema before a component could read it, so a service that changed shape
 * produced a named failure on the screen instead of a wrong number inside it.
 * That app is being deleted. This shell is the product now, and until this file
 * existed it validated NOTHING — `config/intafaced.js` did `JSON.parse` and
 * handed `body.result.data` to a screen on the strength of `body.result` being
 * truthy.
 *
 * WHAT WAS ALREADY HERE IS NOT VALIDATION. `ix-trade.js` is full of
 * `Array.isArray(...)`, `typeof x === 'object'` and `x === undefined ? null : x`.
 * Every one of those is NULL-SAFETY: it asks whether a value is THERE. None of
 * them asks what it IS. A last price arriving as the JSON number `42.5`, as the
 * object `{}`, or as the string `"abc"` passes all three and lands in
 * `Exchange.vue`, which seeds the limit-price field from it. The float is then
 * one click from an order.
 *
 * ── THE RULES, AND WHERE THEY COME FROM ──────────────────────────────────────
 *
 * 1. MONEY IS A DECIMAL STRING, AT MOST 18 PLACES. `/^\d+(\.\d{1,18})?$/`.
 *    Eighteen because that is what the ledger carries; a nineteenth place is a
 *    digit the books cannot reconcile, so rendering it is a claim about
 *    precision the platform does not have. A JSON number in a money field is
 *    refused outright — not coerced, not rounded, refused — because by the time
 *    it reaches the browser the float has already lost whatever it lost.
 *
 * 2. `number` IS FOR COUNTS ONLY. Millisecond timestamps, basis points, chain
 *    ids, sequence numbers. Never a price, an amount, a cost or a fee.
 *
 * 3. `custodial` IS THE LITERAL `false`, NOT A BOOLEAN. A protocol-plane service
 *    answering `true` must be REFUSED rather than rendered, because the screen
 *    would otherwise print a sovereignty claim supplied by the very deployment
 *    that contradicts it. `Dex.vue` renders `health.data.custodial` verbatim
 *    today; a schema is the only thing that can stop it printing `true`.
 *
 * ── WHY THIS IS HAND-WRITTEN AND NOT ZOD ─────────────────────────────────────
 *
 * Two hard constraints, both checked rather than assumed:
 *
 *   - This shell is not a pnpm workspace member (`pnpm-workspace.yaml` lists
 *     `apps/*`, `services/*`, `packages/*`, `tooling/*`), so `@intafaced/*` —
 *     including the contracts these rules are ported from — does not resolve
 *     here. The schemas are MIRRORED, exactly as `wire.ts` mirrored them, and
 *     being a mirror is the feature: when a service changes shape the mirror
 *     stops matching and the screen says which field and which rule.
 *
 *   - This boundary stays deliberately ES5 even though the shell now builds
 *     with webpack 5. It can be required directly by the Node golden tests and
 *     does not depend on transpilation: no `const`, arrow functions, template
 *     literals, or BigInt.
 *
 * ── WHAT A SCHEMA ASSERTS, AND WHAT IT DOES NOT ──────────────────────────────
 *
 * A schema states what this screen READS and what that value must BE. Unknown
 * keys are allowed through — a service is entitled to send more than we render,
 * and refusing a market list because svc-trade grew a field would be this file
 * causing the outage it exists to prevent.
 *
 * PRESENCE IS OFTEN NOT THE INVARIANT; TYPE ALWAYS IS. Most money fields are
 * `optional(nullable(decimal))`: absent is tolerated (`ix-trade.js` already
 * renders a dash for it, and the currently-deployed services are older than the
 * contract), null is tolerated (our ticker publishes null for every 24h rollup
 * because no windowed aggregation job exists), but a number is not. The fields
 * that ARE required are the ones a row cannot be honestly drawn without — a
 * market with no symbol, a trade with no price, an order with no status.
 *
 * Ported from `packages/exchange-contract/src/schemas.ts` (the CCXT REST
 * surface svc-trade actually publishes), `packages/contracts/src/identity.ts`
 * (the tier ladder) and `apps/web/src/lib/api/wire.ts` (the protocol-plane
 * health rules).
 *
 * CommonJS so the golden tests can `require()` it without a bundler, matching
 * `book-honesty.js`, `ix-trade.js` and `withdraw-math.js` beside it.
 */
'use strict';

/* ── the verdict shape ─────────────────────────────────────────────────────── */

/**
 * Every validator answers the same three fields, always.
 *
 * `path` is dotted with bracketed indexes — `bids[3][0]`, `balances.USDT.free` —
 * because "the response was wrong" is not a usable sentence to anyone. The whole
 * value of a failed parse is that it names the field, and the field is where the
 * engineering fault is.
 */
function pass() {
  return { ok: true, path: null, message: null };
}

function fail(path, message) {
  return { ok: false, path: path || '', message: message };
}

function childPath(path, key) {
  return path ? path + '.' + key : String(key);
}

function indexPath(path, i) {
  return (path || '') + '[' + i + ']';
}

/** What arrived, in words a reader can act on. `null` and arrays are their own answers. */
function typeName(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'the JSON number ' + String(value);
  if (typeof value === 'boolean') return 'the boolean ' + String(value);
  return 'a ' + typeof value;
}

/* ── money ─────────────────────────────────────────────────────────────────── */

/** The ledger's rule, byte for byte the one `wire.ts` enforced. */
var UNSIGNED_DECIMAL = /^\d+(\.\d{1,18})?$/;
/** The same rule where a value may legitimately be negative (a percent move, a PnL). */
var SIGNED_DECIMAL = /^-?\d+(\.\d{1,18})?$/;
/** Well-formed but too precise — worth its own sentence, because it names the ledger's limit. */
var OVERLONG_DECIMAL = /^-?\d+\.(\d{19,})$/;

function decimalRule(signed) {
  var re = signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL;
  var label = signed ? 'a decimal string' : 'an unsigned decimal string';

  return function (value, path) {
    if (typeof value !== 'string') {
      // The single most important refusal in this file. A float here has
      // already lost precision upstream; accepting it launders that loss.
      return fail(path, 'expected ' + label + ', got ' + typeName(value) + ' — money never crosses this wire as a JSON number');
    }
    var overlong = OVERLONG_DECIMAL.exec(value);
    if (overlong) {
      return fail(
        path,
        'has ' + overlong[1].length + ' decimal places; the ledger carries at most 18, so the extra digits are precision this platform does not have'
      );
    }
    if (!signed && value.charAt(0) === '-') {
      return fail(path, 'is negative ("' + value + '"), and this field is unsigned');
    }
    if (!re.test(value)) {
      return fail(path, 'is "' + value + '", which is not ' + label + ' matching ' + String(re));
    }
    return pass();
  };
}

var decimal = decimalRule(false);
var signedDecimal = decimalRule(true);

/* ── counts, text, flags ───────────────────────────────────────────────────── */

function text(value, path) {
  if (typeof value !== 'string') return fail(path, 'expected a string, got ' + typeName(value));
  return pass();
}

function nonEmptyText(value, path) {
  var r = text(value, path);
  if (!r.ok) return r;
  if (value === '') return fail(path, 'is an empty string, and this field identifies the row');
  return pass();
}

function bool(value, path) {
  if (typeof value !== 'boolean') return fail(path, 'expected a boolean, got ' + typeName(value));
  return pass();
}

/**
 * A count, not money. Rule 2 lives here: `number` is legal in exactly the places
 * this validator is used, and `decimal` guards everywhere else.
 */
function integer(value, path) {
  if (typeof value !== 'number') return fail(path, 'expected a whole number, got ' + typeName(value));
  if (!isFinite(value)) return fail(path, 'is ' + String(value) + ', which is not a finite number');
  if (Math.floor(value) !== value) return fail(path, 'is ' + String(value) + ', which is not a whole number');
  return pass();
}

/** Milliseconds since epoch. A count of milliseconds, never a date string. */
function timestampMs(value, path) {
  var r = integer(value, path);
  if (!r.ok) return r;
  if (value < 0) return fail(path, 'is ' + String(value) + ', and a millisecond timestamp is never negative');
  return pass();
}

var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuid(value, path) {
  var r = text(value, path);
  if (!r.ok) return r;
  if (!UUID.test(value)) return fail(path, 'is "' + value + '", which is not a UUID');
  return pass();
}

/* ── combinators ───────────────────────────────────────────────────────────── */

/**
 * An exact value, and the reason `custodial` is a literal rather than a boolean.
 * `bool` would happily accept `true`; this refuses it.
 */
function literal(expected) {
  return function (value, path) {
    if (value !== expected) {
      return fail(path, 'must be ' + JSON.stringify(expected) + ', and the service answered ' + JSON.stringify(value));
    }
    return pass();
  };
}

function oneOf(allowed) {
  return function (value, path) {
    for (var i = 0; i < allowed.length; i++) {
      if (value === allowed[i]) return pass();
    }
    return fail(path, 'is ' + JSON.stringify(value) + ', and this field is one of: ' + allowed.join(', '));
  };
}

/** Null is an answer ("the venue has no last price"), and a legal one. */
function nullable(inner) {
  return function (value, path) {
    if (value === null) return pass();
    return inner(value, path);
  };
}

/** Absent is tolerated; present-and-wrong is not. See the header note on presence. */
function optional(inner) {
  return function (value, path) {
    if (value === undefined) return pass();
    return inner(value, path);
  };
}

function arrayOf(inner) {
  return function (value, path) {
    if (!Array.isArray(value)) return fail(path, 'expected an array, got ' + typeName(value));
    for (var i = 0; i < value.length; i++) {
      var r = inner(value[i], indexPath(path, i));
      if (!r.ok) return r;
    }
    return pass();
  };
}

/**
 * A positional array — CCXT's `[price, amount]` level and
 * `[time, o, h, l, c, v]` candle.
 *
 * Longer than the spec is allowed (a venue may append), shorter is not: a level
 * missing its amount is a level the ladder cannot draw.
 */
function tupleOf(members) {
  return function (value, path) {
    if (!Array.isArray(value)) return fail(path, 'expected an array, got ' + typeName(value));
    if (value.length < members.length) {
      return fail(path, 'has ' + value.length + ' entries and needs at least ' + members.length);
    }
    for (var i = 0; i < members.length; i++) {
      var r = members[i](value[i], indexPath(path, i));
      if (!r.ok) return r;
    }
    return pass();
  };
}

/** An object used as a map — the tickers response, the balances block. */
function recordOf(inner) {
  return function (value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(path, 'expected an object keyed by name, got ' + typeName(value));
    }
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var r = inner(value[key], childPath(path, key));
      if (!r.ok) return r;
    }
    return pass();
  };
}

/**
 * An object with named fields. Unknown keys pass through untouched — see the
 * header: a schema says what we read, not what a service may send.
 */
function shape(fields) {
  return function (value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail(path, 'expected an object, got ' + typeName(value));
    }
    for (var key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      var r = fields[key](value[key], childPath(path, key));
      if (!r.ok) return r;
    }
    return pass();
  };
}

/* ── the CCXT REST surface (`/api/v1/*`, svc-trade) ────────────────────────── */

/**
 * `precision.price` / `precision.amount` — the one field with two live shapes,
 * and the reason this is a union rather than a plain `decimal`.
 *
 * The contract (`precisionMode: 'TICK_SIZE'`) sends the tick and lot themselves
 * as decimal strings, because that is what the engine enforces. The service
 * currently in the fleet is older and sends a decimal-PLACE COUNT as a JSON
 * number. `ix-trade.js` already reads both deliberately and branches on the JSON
 * type to tell them apart, so refusing the number here would break the desk
 * against the service that is actually running — this file exists to catch
 * lies, not to fail the shell against the truth.
 *
 * Note this is the ONLY place a JSON number is accepted in a field adjacent to
 * money, and it is accepted as a COUNT (0–18 places), never as a value.
 */
function tickOrPlaceCount(value, path) {
  if (typeof value === 'number') {
    var r = integer(value, path);
    if (!r.ok) return r;
    if (value < 0 || value > 18) {
      return fail(path, 'is the place count ' + String(value) + ', and a place count is 0–18');
    }
    return pass();
  }
  return decimal(value, path);
}

var limitPair = shape({
  min: optional(nullable(decimal)),
  max: optional(nullable(decimal)),
});

/** One CCXT market row, as `ix-trade.js` `toMarketRow` reads it. */
var market = shape({
  /* UUID for depth stream; optional so older fixtures still validate. */
  id: optional(text),
  symbol: nonEmptyText,
  base: optional(text),
  quote: optional(text),
  active: optional(bool),
  /* Fee RATES, and rates are money-shaped: "0.001", never 0.001. */
  maker: optional(nullable(decimal)),
  taker: optional(nullable(decimal)),
  /* Dated futures ISO from presentCcxtMarket. Milliseconds belong on `expiry`. */
  expiryDatetime: optional(nullable(text)),
  precisionMode: optional(literal('TICK_SIZE')),
  precision: optional(
    nullable(
      shape({
        price: optional(nullable(tickOrPlaceCount)),
        amount: optional(nullable(tickOrPlaceCount)),
      })
    )
  ),
  limits: optional(
    nullable(
      shape({
        amount: optional(nullable(limitPair)),
        price: optional(nullable(limitPair)),
        cost: optional(nullable(limitPair)),
        leverage: optional(nullable(limitPair)),
      })
    )
  ),
});

var markets = arrayOf(market);

/**
 * One ticker.
 *
 * `last` is the field that seeds the limit-price input in `Exchange.vue`
 * (`this.form.price = String(current.close)`), which is why it is the headline
 * example in this file's opening note: a JSON number here becomes a float in an
 * order form. Every rollup is `optional(nullable(...))` because our ticker
 * genuinely publishes null for all of them today.
 *
 * `change` and `percentage` are SIGNED — a market that moved down is not an
 * error, and `-0.0142` is the honest value.
 */
var ticker = shape({
  symbol: optional(text),
  timestamp: optional(nullable(timestampMs)),
  datetime: optional(nullable(text)),
  high: optional(nullable(decimal)),
  low: optional(nullable(decimal)),
  bid: optional(nullable(decimal)),
  bidVolume: optional(nullable(decimal)),
  ask: optional(nullable(decimal)),
  askVolume: optional(nullable(decimal)),
  vwap: optional(nullable(decimal)),
  open: optional(nullable(decimal)),
  close: optional(nullable(decimal)),
  last: optional(nullable(decimal)),
  previousClose: optional(nullable(decimal)),
  change: optional(nullable(signedDecimal)),
  percentage: optional(nullable(signedDecimal)),
  average: optional(nullable(decimal)),
  baseVolume: optional(nullable(decimal)),
  quoteVolume: optional(nullable(decimal)),
});

/** `GET /tickers` answers a map keyed by unified symbol, not a list. */
var tickers = recordOf(ticker);

/** `[price, amount]`. Both are money and both are strings. */
var orderBookLevel = tupleOf([decimal, decimal]);

/**
 * `GET /orderbook/:symbol`.
 *
 * `bids` and `asks` are REQUIRED arrays and empty is a success, not a failure —
 * every book on this venue is empty today and that is the true state of the
 * market. What must never pass is a book whose levels are floats.
 */
var orderBook = shape({
  symbol: optional(text),
  bids: arrayOf(orderBookLevel),
  asks: arrayOf(orderBookLevel),
  timestamp: optional(nullable(timestampMs)),
  datetime: optional(nullable(text)),
  nonce: optional(nullable(integer)),
});

/**
 * One print on the public tape, and — same shape on this venue — one private
 * fill from `/account/trades`.
 *
 * `side` is required because `toDeskSide` falls back to BUY for anything it does
 * not recognise, so an unreadable side does not render as unknown, it renders as
 * a green row. `price` and `amount` are required because a print without them is
 * not a print.
 */
var trade = shape({
  id: optional(text),
  order: optional(nullable(text)),
  timestamp: optional(nullable(timestampMs)),
  datetime: optional(nullable(text)),
  symbol: optional(text),
  type: optional(nullable(text)),
  side: oneOf(['buy', 'sell']),
  takerOrMaker: optional(nullable(oneOf(['taker', 'maker']))),
  price: decimal,
  amount: decimal,
  cost: optional(nullable(decimal)),
  fee: optional(
    nullable(
      shape({
        cost: decimal,
        currency: text,
        rate: optional(nullable(signedDecimal)),
      })
    )
  ),
});

var trades = arrayOf(trade);

/** `[timestamp, open, high, low, close, volume]` — one count, five prices. */
var candle = tupleOf([timestampMs, decimal, decimal, decimal, decimal, decimal]);

var ohlcv = arrayOf(candle);

/**
 * One order, from `/orders/open`, `/orders/closed` or the answer to a `POST`.
 *
 * `price` is nullable because a market order has none and the desk prints
 * "Market" for it. `cost` is nullable because the venue genuinely cannot always
 * say what quote moved, and null keeps "unknown" distinguishable from "nothing".
 * `status` is required and enumerated: `toDeskStatus` upper-cases anything it
 * does not know, so an unrecognised status renders as a plausible-looking word
 * rather than as a fault.
 */
var order = shape({
  id: nonEmptyText,
  clientOrderId: optional(nullable(text)),
  timestamp: optional(nullable(timestampMs)),
  datetime: optional(nullable(text)),
  lastTradeTimestamp: optional(nullable(timestampMs)),
  symbol: optional(text),
  type: oneOf(['market', 'limit', 'stop', 'stop_limit', 'take_profit']),
  side: oneOf(['buy', 'sell']),
  timeInForce: optional(nullable(oneOf(['GTC', 'IOC', 'FOK', 'PO', 'GTD', 'GTT']))),
  expireAt: optional(nullable(text)),
  postOnly: optional(bool),
  reduceOnly: optional(bool),
  price: optional(nullable(decimal)),
  stopPrice: optional(nullable(decimal)),
  average: optional(nullable(decimal)),
  amount: decimal,
  filled: decimal,
  remaining: optional(nullable(decimal)),
  cost: optional(nullable(decimal)),
  status: oneOf(['open', 'closed', 'canceled', 'expired', 'rejected']),
  fee: optional(nullable(shape({ cost: decimal, currency: text }))),
  trades: optional(nullable(trades)),
});

var orders = arrayOf(order);

/**
 * `GET /account/balance`.
 *
 * `balances` is required and `{}` is a valid, successful answer — an account
 * that has never held anything. `toBalanceRows` renders that as a named empty
 * state, which is correct; what it must never receive is a float free balance.
 */
var balances = shape({
  timestamp: optional(nullable(timestampMs)),
  datetime: optional(nullable(text)),
  balances: recordOf(
    shape({
      free: decimal,
      used: decimal,
      total: decimal,
    })
  ),
});

/* ── the tRPC surface ──────────────────────────────────────────────────────── */

/** A plain `/health` from any service. Says nothing about custody. */
var serviceHealth = shape({
  ok: bool,
  service: nonEmptyText,
});

/**
 * A PROTOCOL-PLANE health answer, and the reason `custodial` is
 * `literal(false)`.
 *
 * The plane's entire claim is that the platform holds nothing there. If a
 * deployment answers `true`, the honest response is to refuse the payload — not
 * to render it — because `Dex.vue` prints `health.data.custodial` verbatim, so
 * a broken deployment would otherwise publish its own contradiction as a fact
 * under our sovereignty copy. Ported from `wire.ts` `protocolHealthSchema`,
 * which took the rule from svc-protocol's own router; svc-dex declares the same
 * literal (`services/svc-dex/src/router.ts`).
 *
 * @param {string} serviceName e.g. 'svc-dex'
 */
function sovereignHealth(serviceName) {
  return shape({
    ok: bool,
    service: literal(serviceName),
    custodial: literal(false),
  });
}

var dexHealth = sovereignHealth('svc-dex');

var protocolHealth = shape({
  ok: bool,
  service: literal('svc-protocol'),
  chainId: optional(integer),
  custodial: literal(false),
  relayEnabled: optional(bool),
});

/* ── svc-identity ──────────────────────────────────────────────────────────── */

var KYC_TIERS = ['none', 'basic', 'full', 'institutional'];
var kycTier = oneOf(KYC_TIERS);

var session = shape({
  accessToken: nonEmptyText,
  refreshToken: nonEmptyText,
  expiresAt: text,
  userId: uuid,
});

var kycStatus = shape({
  tier: kycTier,
  records: arrayOf(
    shape({
      id: uuid,
      tier: kycTier,
      jurisdiction: text,
      status: oneOf(['pending', 'approved', 'rejected', 'expired']),
      createdAt: text,
    })
  ),
});

/* ── the entry point ───────────────────────────────────────────────────────── */

/**
 * Run a schema over a parsed body. Never throws, always answers.
 *
 * A missing schema is a PASS, not a failure: validation is opt-in per call site
 * (`config/intafaced.js` takes it as an optional argument), and a call that has
 * not adopted one yet is exactly as safe as it was before this file existed —
 * no worse, and visibly not yet better.
 *
 * @returns {{ ok: boolean, path: string|null, message: string|null }}
 */
function validate(schema, value) {
  if (typeof schema !== 'function') return pass();
  try {
    var r = schema(value, '');
    if (!r || typeof r.ok !== 'boolean') return pass();
    return r;
  } catch (e) {
    // A validator that throws is a bug in THIS file. Say so plainly rather than
    // letting the exception surface as an unreachable service.
    return fail('', 'the response could not be checked: ' + (e && e.message ? e.message : String(e)));
  }
}

/**
 * One sentence naming the field and the rule it broke, for `IxState` to print
 * under "the service said". This is the whole product of a failed parse.
 */
function describe(result) {
  if (!result || result.ok) return '';
  var where = result.path ? result.path : 'the response body';
  return where + ' ' + result.message;
}

module.exports = {
  // verdicts
  validate: validate,
  describe: describe,

  // primitives — exported so a screen can state a rule this file has not met yet
  decimal: decimal,
  signedDecimal: signedDecimal,
  text: text,
  nonEmptyText: nonEmptyText,
  bool: bool,
  integer: integer,
  timestampMs: timestampMs,
  uuid: uuid,

  // combinators
  literal: literal,
  oneOf: oneOf,
  nullable: nullable,
  optional: optional,
  arrayOf: arrayOf,
  tupleOf: tupleOf,
  recordOf: recordOf,
  shape: shape,

  // the CCXT REST surface
  market: market,
  markets: markets,
  ticker: ticker,
  tickers: tickers,
  orderBookLevel: orderBookLevel,
  orderBook: orderBook,
  trade: trade,
  trades: trades,
  candle: candle,
  ohlcv: ohlcv,
  order: order,
  orders: orders,
  balances: balances,

  // the tRPC surface
  serviceHealth: serviceHealth,
  sovereignHealth: sovereignHealth,
  dexHealth: dexHealth,
  protocolHealth: protocolHealth,

  // svc-identity
  KYC_TIERS: KYC_TIERS,
  kycTier: kycTier,
  session: session,
  kycStatus: kycStatus,
};
