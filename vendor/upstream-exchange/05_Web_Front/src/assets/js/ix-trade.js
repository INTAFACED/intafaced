/**
 * svc-trade CCXT wire → the shapes the vendored desk already renders.
 *
 * WHY AN ADAPTER AND NOT A REWRITE. The trading screens in this shell are the
 * product (ADR 2026-08-02). Their layout, keyboard handling, error-summary
 * focus management and empty-state wiring are the valuable part and none of it
 * is wrong — what is wrong is that every one of them reads a dead Java backend.
 * So the wire changes and the presentation does not, and this file is the one
 * place the two vocabularies meet. A screen that translated inline would have
 * to be re-read line by line to answer "does this ever invent a number".
 *
 * THREE RULES, AND THEY ARE THE POINT
 *
 * 1. MONEY STAYS A STRING. Every price, amount, cost and fee arrives from
 *    svc-trade as a decimal string and leaves here as the same decimal string,
 *    byte for byte. Nothing in this file calls Number() on an amount. The desk
 *    does parse some of them for pixel arithmetic (bar widths, percent sizing)
 *    and that is display, not money — but the value that goes back out to
 *    `POST /api/v1/orders` is the string the user typed, never a round-tripped
 *    float. (Order-ticket float paths are owned by ix-money.js — see that
 *    file's header.)
 *
 * 2. ABSENT IS NOT ZERO. Our ticker publishes `null` for every 24h rollup
 *    because no windowed aggregation job exists, and `null` for last price when
 *    a market has never traded. Those come through as null and the desk prints
 *    a dash. Turning them into 0 would put a real-looking number on a screen
 *    that has no idea what the price is, which is the single easiest way for
 *    this platform to tell a lie.
 *
 * 3. EMPTY IS AN ANSWER. `[]` from `/orderbook`, `/trades`, `/ohlcv` or
 *    `/orders/open` means the venue answered and there is nothing there. It is
 *    NOT a failure and must never be rendered as one — no spinner, no "did not
 *    respond". The books are empty today and that is the true state of the
 *    market. The callers set `reachable = true` on an empty array on purpose.
 *
 * 4. SHAPE BEFORE ADAPT. Call sites that read a live REST body run `accept()`
 *    with a schema from `ix-wire.js` BEFORE any `toDesk*` / `toPlate*` /
 *    `toMarket*` adapter. A float price, a 19dp amount or a custodial:true
 *    health answer becomes `invalid_response` naming the field — it never
 *    reaches a form, a ladder or a sovereignty badge.
 *
 * CommonJS so the golden tests can require() it without a bundler, matching
 * book-honesty.js and desk-prefs.js beside it.
 */
'use strict';

var wire = require('./ix-wire.js');
var ixMoney = require('./ix-money.js');

/**
 * The schemas the desk's REST reads actually contract for.
 * Screens pass these to `accept()` — never invent ad-hoc shapes.
 */
var schemas = {
  markets: wire.markets,
  tickers: wire.tickers,
  orderBook: wire.orderBook,
  trades: wire.trades,
  ohlcv: wire.ohlcv,
  order: wire.order,
  orders: wire.orders,
  balances: wire.balances,
  /* Protocol-plane health: custodial must be literal false (sovereignty). */
  dexHealth: wire.dexHealth,
  protocolHealth: wire.protocolHealth
};

/**
 * Gate a raw wire payload before any adapter reads it.
 *
 * Same result shape as `config/intafaced.js` rest()/query() so a screen can
 * branch on `ok` / `reason` / `message` identically for transport failures and
 * shape failures. Missing schema is a pass (opt-in), matching wire.validate.
 *
 * @param {function|null|undefined} schema  from `schemas` / ix-wire
 * @param {*} data  already-unwrapped body (the `data` field of a rest result)
 * @returns {{ ok: boolean, reason: string, message: string|null, data: * }}
 */
function accept(schema, data) {
  var r = wire.validate(schema, data);
  if (!r || r.ok) {
    return { ok: true, reason: 'ok', message: null, data: data };
  }
  return {
    ok: false,
    reason: 'invalid_response',
    message: wire.describe(r),
    data: null
  };
}

/** CCXT order side → the desk's BUY/SELL vocabulary. */
function toDeskSide(side) {
  return String(side).toLowerCase() === 'sell' ? 'SELL' : 'BUY';
}

/** The desk's BUY/SELL → the CCXT wire's buy/sell. */
function toWireSide(side) {
  return String(side).toUpperCase() === 'SELL' ? 'sell' : 'buy';
}

/** CCXT order type → the desk's LIMIT_PRICE/MARKET_PRICE vocabulary. */
function toDeskType(type) {
  var value = String(type || '').toLowerCase();
  if (value === 'market') return 'MARKET_PRICE';
  if (value === 'limit') return 'LIMIT_PRICE';
  if (value === 'stop') return 'STOP';
  if (value === 'stop_limit') return 'STOP_LIMIT';
  if (value === 'take_profit') return 'TAKE_PROFIT';
  return String(type || '').toUpperCase();
}

/** The desk's order-type constant → the CCXT wire's market/limit. */
function toWireType(type) {
  var value = String(type || '').toLowerCase();
  if (value === 'market_price') return 'market';
  if (value === 'limit_price') return 'limit';
  if (value === 'market' || value === 'limit' || value === 'stop' || value === 'stop_limit' || value === 'take_profit') return value;
  return 'limit';
}

/**
 * CCXT order status → the desk's status vocabulary.
 *
 * `expired` and `rejected` deliberately do NOT collapse into CANCELED. The desk
 * prints the status verbatim through statusLabel(), and an order the venue
 * refused is a different event from one the user pulled — flattening them hides
 * a rejection behind a word that implies the user did it.
 */
function toDeskStatus(status) {
  switch (String(status)) {
    case 'open':
      return 'TRADING';
    case 'closed':
      return 'COMPLETED';
    case 'canceled':
      return 'CANCELED';
    case 'expired':
      return 'EXPIRED';
    case 'rejected':
      return 'REJECTED';
    default:
      return String(status || '').toUpperCase();
  }
}

/**
 * One CCXT order → one desk blotter row.
 *
 * `detail` is `[]` and stays that way. The vendor row carried a nested fill
 * list because the Java order endpoint embedded one; ours does not, and fills
 * are a separate call (`/api/v1/account/trades`). An empty array here means the
 * expander shows nothing, which is correct — it does not mean zero fills, and
 * the Trade History tab is where fills actually live.
 */
function toDeskOrder(order) {
  if (!order || typeof order !== 'object') return null;
  return {
    orderId: order.id,
    clientOrderId: order.clientOrderId || null,
    symbol: order.symbol,
    type: toDeskType(order.type),
    direction: toDeskSide(order.side),
    /* null for a market order — the desk renders "Market", not a price. */
    price: order.price,
    amount: order.amount,
    tradedAmount: order.filled,
    /* `cost` is null when the venue genuinely cannot say what quote moved
       (a market sell with no fills loaded). Passing the null through keeps
       "unknown" distinguishable from "nothing". */
    turnover: order.cost,
    time: order.timestamp,
    status: toDeskStatus(order.status),
    /* Additive svc-trade recovery evidence. CCXT keeps unresolved rows
       parseable as open; these fields are authoritative for the desk label. */
    recoveryReason: order.recoveryReason || null,
    reconciliationKey: order.reconciliationKey || null,
    executionOutcome: order.executionOutcome || null,
    recoveryRequired: order.recoveryRequired === true,
    lifecycleState: order.lifecycleState || null,
    tif: order.timeInForce || null,
    expireAt: order.expireAt || null,
    postOnly: order.postOnly === true,
    detail: []
  };
}

/** A list of CCXT orders → desk rows, dropping anything unreadable. */
function toDeskOrders(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var row = toDeskOrder(list[i]);
    if (row) out.push(row);
  }
  return out;
}

/**
 * One CCXT public print → one desk tape row.
 * `side` on a public print is the TAKER's side (the aggressor), which is what
 * the tape colours by on every venue.
 */
function toDeskTrade(print) {
  if (!print || typeof print !== 'object') return null;
  return {
    time: print.timestamp,
    price: print.price,
    amount: print.amount,
    turnover: print.cost,
    direction: toDeskSide(print.side)
  };
}

function toDeskTrades(list, limit) {
  if (!Array.isArray(list)) return [];
  var out = [];
  var max = limit > 0 ? limit : list.length;
  for (var i = 0; i < list.length && out.length < max; i++) {
    var row = toDeskTrade(list[i]);
    if (row) out.push(row);
  }
  return out;
}

/**
 * CCXT `[price, amount]` pairs → the `{ price, amount }` items the desk's
 * existing applyPlate() normalises.
 *
 * Deliberately does NOT filter or total here — normalizePlateLevels() in
 * book-honesty.js already drops non-positive levels and computes the running
 * total, and having one owner of that rule is why an empty book cannot acquire
 * a phantom level on the way through.
 */
function toPlateItems(levels) {
  if (!Array.isArray(levels)) return [];
  var out = [];
  for (var i = 0; i < levels.length; i++) {
    var level = levels[i];
    if (!Array.isArray(level) || level.length < 2) continue;
    out.push({ price: level[0], amount: level[1] });
  }
  return out;
}

/**
 * One CCXT private fill → one desk Trade History row.
 * Fee is an object on the wire (cost + currency + rate); the desk wants the
 * cost, and the currency rides along so it is never printed as if it were the
 * quote asset when it is not.
 */
function toDeskFill(fill) {
  if (!fill || typeof fill !== 'object') return null;
  var fee = fill.fee || null;
  return {
    time: fill.timestamp,
    symbol: fill.symbol,
    direction: toDeskSide(fill.side),
    price: fill.price,
    amount: fill.amount,
    turnover: fill.cost,
    fee: fee ? fee.cost : null,
    feeAsset: fee ? fee.currency : null,
    liquidity: fill.takerOrMaker || null,
    orderId: fill.order || null
  };
}

function toDeskFills(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var row = toDeskFill(list[i]);
    if (row) out.push(row);
  }
  return out;
}

/**
 * `GET /api/v1/account/balance` → a sorted row list.
 *
 * The wire is `{ timestamp, datetime, balances: { ASSET: { free, used, total } } }`
 * and an account with nothing in it answers `balances: {}`. That empties to
 * `[]` here, which the screens render as a named empty state — NOT as a table
 * of every listed asset showing 0.00, which would be a fabricated claim about
 * assets the ledger has never held a row for.
 */
function toBalanceRows(payload) {
  var balances = (payload && payload.balances) || null;
  if (!balances || typeof balances !== 'object') return [];
  var assets = Object.keys(balances).sort();
  var rows = [];
  for (var i = 0; i < assets.length; i++) {
    var asset = assets[i];
    var row = balances[asset] || {};
    rows.push({
      unit: asset,
      /* Decimal strings, verbatim. */
      free: row.free,
      used: row.used,
      total: row.total
    });
  }
  return rows;
}

/** The free (available) balance for one asset, or null when the ledger has no row. */
function freeBalanceOf(rows, asset) {
  if (!Array.isArray(rows) || !asset) return null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].unit === asset) return rows[i].free;
  }
  /* No row is NOT a zero balance in a UI sense: it means the ledger has never
     held this asset for this user. The caller decides how to say that. */
  return null;
}

/**
 * `GET /api/v1/markets` + `GET /api/v1/tickers` → the desk's market-list rows.
 *
 * Every rollup our ticker cannot source is null and stays null: `high`, `low`,
 * `baseVolume`, `change` and `percentage` are all null on this venue today
 * because no windowed aggregation job exists. `close`/`last` is null until the
 * market has actually printed.
 *
 * `chg` and `rose` are therefore null rather than 0 / "+0.00%". A market list
 * showing a column of green +0.00% would read as sixteen flat markets, which is
 * a statement about price movement we have no data to make.
 */
function toMarketRow(market, ticker) {
  if (!market || typeof market !== 'object') return null;
  var t = ticker || {};
  var symbol = market.symbol || '';
  var parts = String(symbol).split('/');
  var coin = market.base || parts[0] || '';
  var base = market.quote || parts[1] || '';
  var pct = t.percentage === undefined ? null : t.percentage;

  return {
    /* Venue market UUID — required for svc-ws `/ws/stream?market=<id>`.
       Absent on older shapes; feed stays REST-only then (no invent id). */
    id: market.id === undefined || market.id === null ? null : String(market.id),
    symbol: symbol,
    coin: coin,
    base: base,
    href: (coin + '_' + base).toLowerCase(),
    active: market.active !== false,
    /* Decimal strings or null — never coerced. */
    close: t.last === undefined ? null : t.last,
    bid: t.bid === undefined ? null : t.bid,
    ask: t.ask === undefined ? null : t.ask,
    high: t.high === undefined ? null : t.high,
    low: t.low === undefined ? null : t.low,
    volume: t.baseVolume === undefined ? null : t.baseVolume,
    chg: pct,
    /* Null, not "+0.00%". There is no 24h window to compute a move over. */
    rose: pct === null || pct === undefined ? null : formatPercent(pct),
    /* The tick and lot the ENGINE enforces, when the venue published them.
       Null against an older service that only sent a decimal-place count — see
       sizeFromPrecision. Never reconstructed from that count, because a place
       count cannot express the lot of 1000 that seven of our listings use. */
    tickSize: market.precision ? sizeFromPrecision(market.precision.price) : null,
    lotSize: market.precision ? sizeFromPrecision(market.precision.amount) : null,
    /* Display-only digit counts, correct under either precision shape. */
    pricePlaces: market.precision ? placesFromPrecision(market.precision.price) : null,
    amountPlaces: market.precision ? placesFromPrecision(market.precision.amount) : null,
    minNotional: market.limits && market.limits.cost ? market.limits.cost.min : null,
    minQty: market.limits && market.limits.amount ? market.limits.amount.min : null,
    maker: market.maker === undefined ? null : market.maker,
    taker: market.taker === undefined ? null : market.taker,
    isFavor: false
  };
}

/**
 * Decimal places for display, from whichever `precision` shape the venue sent.
 *
 * TWO SHAPES ARE LIVE AT ONCE, AND GETTING THIS WRONG IS SILENT.
 *
 *   new (main, `precisionMode: 'TICK_SIZE'`)  precision.price = "0.00001"
 *   old (currently deployed)                  precision.price = 5
 *
 * The new form is the tick size itself, because that is what the engine
 * actually enforces; the old form is a decimal-place count. They are both
 * "5 decimal places" here but they are different values, and reading one as the
 * other does not throw — it just formats every price on the desk to the wrong
 * number of digits. A tick of "0.00001" read as a place count gives 0 places,
 * so a five-decimal FX pair renders as whole numbers.
 *
 * DETECTION IS ON THE JSON TYPE, NOT ON THE TEXT. The old shape sends numbers
 * and the new one sends decimal strings, which is unambiguous. Sniffing for a
 * decimal point is not: a whole-number lot of `"1000"` (AUD/USD, and six other
 * listings) and a place count both lack one, and reading that lot as a place
 * count of 1000 is nonsense that would silently fall back to a default scale.
 *
 * THIS IS FOR DISPLAY ONLY. It is never used to build an order quantity. The
 * lot for AUD/USD is 1000, whose place count is 0, and rounding an amount to 0
 * places produces sizes the engine rejects for a reason the trader cannot see.
 */
function placesFromPrecision(value) {
  if (value === null || value === undefined || value === '') return null;
  // Old shape: an integer count of decimal places.
  if (typeof value === 'number') {
    return isFinite(value) && value >= 0 && value <= 18 ? Math.floor(value) : null;
  }
  // New shape: the tick or lot itself, as a decimal string.
  var text = String(value);
  var dot = text.indexOf('.');
  if (dot < 0) return 0; // a whole-number tick/lot ("1", "1000") → no decimals
  return text.slice(dot + 1).replace(/0+$/, '').length;
}

/**
 * The tick/lot size itself, or null when the venue only sent a place count.
 * Null is honest: an older service genuinely did not tell us the tick, and
 * reconstructing one from a place count would invent the venue's own rule.
 */
function sizeFromPrecision(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return null;
  return String(value);
}

/** A decimal-string rate ("0.0123") → a signed percent label. Null in, null out. */
function formatPercent(rate) {
  if (rate === null || rate === undefined || rate === '') return null;
  var n = parseFloat(rate);
  if (!isFinite(n)) return null;
  return (n > 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
}

/**
 * Merge the markets list with the tickers map into desk rows.
 * A market with no ticker entry still appears — it is listed, it just has no
 * price yet, and hiding it would misrepresent what this venue offers.
 */
function toMarketRows(markets, tickers) {
  if (!Array.isArray(markets)) return [];
  var map = tickers && typeof tickers === 'object' ? tickers : {};
  var out = [];
  for (var i = 0; i < markets.length; i++) {
    var row = toMarketRow(markets[i], map[markets[i] && markets[i].symbol]);
    if (row) out.push(row);
  }
  return out;
}

/**
 * CCXT OHLCV rows `[ts, o, h, l, c, v]` → the desk chart's candle objects.
 *
 * Prices stay strings here; the chart library parses them at the last moment
 * for pixel positions. An empty array in gives an empty array out and the
 * caller renders "no candles yet" — never a flat line at zero, which is a
 * price series we invented.
 */
function toCandles(rows) {
  if (!Array.isArray(rows)) return [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!Array.isArray(row) || row.length < 6) continue;
    out.push({
      time: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5]
    });
  }
  return out;
}

/**
 * The desk's chart interval ids → the timeframes svc-trade's `timeframeSchema`
 * accepts. An id with no mapping returns null so the caller can say the
 * timeframe is not served rather than silently charting a different one — a
 * chart labelled 1W showing 1m candles is worse than no chart.
 */
var TIMEFRAME_BY_INTERVAL = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '240': '4h',
  '1D': '1d',
  '1W': '1w'
};

function toTimeframe(interval) {
  var tf = TIMEFRAME_BY_INTERVAL[String(interval)];
  return tf === undefined ? null : tf;
}

/**
 * Build the `POST /api/v1/orders` body.
 *
 * `amount` and `price` are passed through as the STRINGS the caller holds. The
 * contract's `decimal` schema takes a decimal string and the ledger parses it
 * to a scaled bigint; routing it through a JS number first would silently
 * round at the seventeenth digit on exactly the values that matter most.
 *
 * A market order carries NO price key at all rather than `price: "0"`. The
 * schema rejects a price on a market order, and "0" would in any case be a
 * price we made up.
 */
function toCreateOrderBody(input) {
  var body = {
    symbol: input.symbol,
    type: toWireType(input.type),
    side: toWireSide(input.side),
    amount: String(input.amount)
  };
  if (body.type === 'limit' || body.type === 'stop_limit') {
    body.price = String(input.price);
  }
  if (body.type === 'stop' || body.type === 'stop_limit' || body.type === 'take_profit') {
    body.stopPrice = String(input.stopPrice);
  }
  if (input.timeInForce) body.timeInForce = String(input.timeInForce);
  if (input.postOnly === true) body.postOnly = true;
  if (input.reduceOnly === true) body.reduceOnly = true;
  if (input.clientOrderId) body.clientOrderId = String(input.clientOrderId);
  if (input.subAccountId) body.subAccountId = String(input.subAccountId);
  return body;
}

/**
 * Build the bounded cancel-then-replace body from the same decimal strings as
 * the ordinary ticket. Keeping this as a named helper makes the replacement
 * route auditable without introducing a second order client or money shape.
 */
function toReplaceOrderBody(input) {
  return toCreateOrderBody(input);
}

/**
 * Native PATCH body: remaining quantity only, as the typed decimal string.
 * Price/side/TIF are not sent — a formatted-same-looking price that parsed
 * differently would be CANCEL_REPLACE on the service, and this helper is only
 * used after amendRoute has already named NATIVE_AMEND.
 */
function toAmendOrderBody(input) {
  return { amount: String(input.amount) };
}

function sameDecimal(a, b) {
  if (typeof ixMoney.compare !== 'function') return false;
  return ixMoney.compare(a, b) === 0;
}

function qtyNativeAmendable(nextQty, originalQty) {
  if (typeof ixMoney.compare !== 'function' || typeof ixMoney.isPositive !== 'function') return false;
  if (!ixMoney.isPositive(nextQty) || !ixMoney.isPositive(originalQty)) return false;
  return ixMoney.compare(nextQty, originalQty) !== null;
}

function ticketTif(ticket) {
  if (!ticket) return '';
  if (ticket.postOnly === true || ticket.timeInForce === 'PO') return 'PO';
  return String(ticket.timeInForce || 'GTC');
}

function originalTif(original) {
  if (!original) return '';
  if (original.postOnly === true || original.tif === 'PO') return 'PO';
  return String(original.tif || original.timeInForce || 'GTC');
}

/**
 * Desk routing for an amend ticket.
 *
 * NATIVE_AMEND — qty change (down, equal, or up) at the same price, side, type,
 * market, and TIF on a resting limit. Qty-up uses the service ledger hold.
 * No mid is invented; PATCH sends remaining qty only.
 * CANCEL_REPLACE — price, side, market, type, or TIF change. Named cancel/
 * replace; never labelled native and never assumed to keep queue.
 */
function amendRoute(original, ticket) {
  if (!original || !ticket) return 'CANCEL_REPLACE';
  var origType = String(original.type || '').toUpperCase();
  var ticketType = String(ticket.type || '').toUpperCase();
  if (origType !== 'LIMIT_PRICE' || ticketType !== 'LIMIT_PRICE') return 'CANCEL_REPLACE';
  var origSide = String(original.direction || original.side || '').toUpperCase();
  var ticketSide = String(ticket.side || '').toUpperCase();
  if (origSide !== ticketSide) return 'CANCEL_REPLACE';
  if (String(original.symbol || '') !== String(ticket.symbol || '')) return 'CANCEL_REPLACE';
  if (originalTif(original) !== ticketTif(ticket)) return 'CANCEL_REPLACE';
  if (!sameDecimal(original.price, ticket.price)) return 'CANCEL_REPLACE';
  if (!qtyNativeAmendable(ticket.amount, original.amount)) return 'CANCEL_REPLACE';
  return 'NATIVE_AMEND';
}

/**
 * Reject copy for a failed create/cancel, built from the client's classified
 * result rather than from an HTTP status.
 *
 * Always ends in a sentence that says the order did not happen. The failure a
 * trading screen must never produce is an ambiguous one: a user who cannot tell
 * whether their order is live will either place it twice or leave real risk on
 * the book believing it was refused.
 */
function orderFailureMessage(result, action) {
  var verb = action === 'cancel' ? 'The order was not cancelled.' : 'No order was placed.';
  if (!result) return 'The venue did not respond. ' + verb;
  var said = result.message && String(result.message).trim();
  switch (result.reason) {
    case 'unreachable':
      return 'The venue did not answer. ' + verb;
    case 'unauthorized':
      return 'Your session is not signed in to the platform. ' + verb;
    case 'scope_denied':
      return 'This session does not carry the trading scope. ' + verb + (said ? ' (' + said + ')' : '');
    case 'tier_required':
      return 'Trading here requires a verification tier this account has not reached. ' + verb;
    case 'forbidden':
      return (said || 'The venue refused this order.') + ' ' + verb;
    case 'bad_symbol':
      return 'This market is not listed on the venue. ' + verb;
    case 'not_supported':
      return (said || 'The venue does not support this order.') + ' ' + verb;
    case 'not_routed':
    case 'not_mounted':
      return 'The trading service is not reachable through the front door. ' + verb;
    default:
      return (said || 'The venue refused the request.') + ' ' + verb;
  }
}

/**
 * Empty-state copy for a section fed by the CCXT REST client.
 *
 * The three states are kept apart on purpose and this is the function that
 * refuses to let them merge:
 *
 *   loading   we have not heard back           → "Loading…"
 *   failed    we heard a refusal               → the reason, named
 *   empty     we heard, and there is nothing   → the honest empty sentence
 *
 * The third is the state this venue is in today for every book and every tape.
 * It is a success.
 */
function sectionEmptyLabel(section, emptyText) {
  if (!section || section.loading) return 'Loading…';
  if (section.reason && section.reason !== 'ok') {
    return section.message ? section.message : 'The venue did not answer.';
  }
  return emptyText;
}

module.exports = {
  /* wire gate — run before every toDesk* / toPlate* / toMarket* on live reads */
  accept: accept,
  schemas: schemas,
  wire: wire,

  toDeskSide: toDeskSide,
  toWireSide: toWireSide,
  toDeskType: toDeskType,
  toWireType: toWireType,
  toDeskStatus: toDeskStatus,
  toDeskOrder: toDeskOrder,
  toDeskOrders: toDeskOrders,
  toDeskTrade: toDeskTrade,
  toDeskTrades: toDeskTrades,
  toPlateItems: toPlateItems,
  toDeskFill: toDeskFill,
  toDeskFills: toDeskFills,
  toBalanceRows: toBalanceRows,
  freeBalanceOf: freeBalanceOf,
  toMarketRow: toMarketRow,
  toMarketRows: toMarketRows,
  placesFromPrecision: placesFromPrecision,
  sizeFromPrecision: sizeFromPrecision,
  formatPercent: formatPercent,
  toCandles: toCandles,
  toTimeframe: toTimeframe,
  TIMEFRAME_BY_INTERVAL: TIMEFRAME_BY_INTERVAL,
  toCreateOrderBody: toCreateOrderBody,
  toReplaceOrderBody: toReplaceOrderBody,
  toAmendOrderBody: toAmendOrderBody,
  amendRoute: amendRoute,
  orderFailureMessage: orderFailureMessage,
  sectionEmptyLabel: sectionEmptyLabel
};

require('./ix-gtd-ticket.js');
require('./ix-reduce-only-ticket.js');

require('./ix-cod-ticket.js');
