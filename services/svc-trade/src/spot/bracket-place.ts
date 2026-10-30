/**
 * Place a linked bracket with entry, take-profit, and stop-loss through matching (#3658).
 * One submit. Entry fill rests the exits. Refuse if any leg is missing.
 * Trade does not invent a trigger.
 *
 * An OTO (J-cex-spot-08 #10) is the same entry with one attached close instead of the exit pair: a sell limit at the
 * close price for the base the entry received. It shares the bracket's stored intent, place grant and sweep.
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 * Not a redo of #3658 (matching rest) or #3634 (OCO place).
 */
import type { Principal } from '@intafaced/auth';
import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { carriedPlacementBody, withoutCarriedBody } from './placement-extras.js';
import { orderIdFor } from './ids.js';
import { isEngineStpMode } from './placement-options.js';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';

export type BracketLeg = {
  readonly price?: string;
  readonly stopPrice: string;
};

export type PlaceWithBracket = PlaceOrderInput & {
  bracket?: boolean;
  takeProfit?: Amount | BracketLeg | string | null;
  stopLoss?: Amount | BracketLeg | string | null;
  /** An OTO: one close, a sell limit at `close`, placed for what the entry received. */
  oto?: boolean;
  close?: Amount | BracketLeg | string | null;
};

/** Which linked exit an entry carries: the take-profit and stop-loss pair, or one attached close. */
export type ExitKind = 'bracket' | 'oto';

const FLAG = Symbol.for('intafaced.trade.bracketPlace');

function clientKey(rec: Readonly<Record<string, unknown>>): string | null {
  return typeof rec.clientOrderId === 'string' && rec.clientOrderId.length > 0 ? rec.clientOrderId : null;
}

function refuseIeee(field: string): never {
  throw new TradeError(`${field} is a JSON number — decimal string required`, 'trade.ieee_money');
}

function asLeg(raw: unknown): BracketLeg | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') refuseIeee('stopPrice');
  if (typeof raw === 'string') {
    const stopPrice = raw.trim();
    return stopPrice.length > 0 ? { stopPrice } : null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.stopPrice === 'number' || typeof rec.price === 'number') refuseIeee('stopPrice');
  const stop = typeof rec.stopPrice === 'string' ? rec.stopPrice : typeof rec.price === 'string' ? rec.price : '';
  if (stop.length === 0) return null;
  const leg: BracketLeg = { stopPrice: stop };
  if (typeof rec.price === 'string' && rec.price.length > 0) return { ...leg, price: rec.price };
  return leg;
}

function triggerOf(raw: unknown): Amount | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'bigint') return raw <= ZERO ? null : (raw as Amount);
  const leg = asLeg(raw);
  if (!leg) return null;
  try {
    const qty = parseAmount(leg.stopPrice);
    if (qty <= ZERO) return null;
    return qty;
  } catch {
    return null;
  }
}

export function wantsBracket(rec: { readonly bracket?: boolean }): boolean {
  return rec.bracket === true;
}

export function wantsOto(rec: { readonly oto?: boolean }): boolean {
  return rec.oto === true;
}

export function readEntry(order: { readonly type?: string; readonly price?: Amount | null }): Amount | null {
  if (order.type === 'market') return null;
  if (order.price === undefined || order.price === null || order.price <= ZERO) return null;
  return order.price;
}

export function entryRefuse(order: { readonly type?: string; readonly price?: Amount | null }, name = 'a bracket'): TradeError | null {
  if (order.type === 'market') return null;
  if (readEntry(order) !== null) return null;
  return new TradeError(`${name} entry is missing; trade does not invent a trigger`, 'trade.missing_price');
}

export function takeProfitRefuse(takeProfit: Amount | null): TradeError | null {
  if (takeProfit !== null) return null;
  return new TradeError('a bracket take-profit is missing; trade does not invent a trigger', 'trade.missing_stop_price');
}

export function stopLossRefuse(stopLoss: Amount | null): TradeError | null {
  if (stopLoss !== null) return null;
  return new TradeError('a bracket stop-loss is missing; trade does not invent a trigger', 'trade.missing_stop_price');
}

/**
 * The legs this request's own body asks for, or null when it is neither a bracket nor an OTO. Refuses what it cannot
 * read. An OTO's close is a price (`close: { price }`); a stop close is not offered, so a `stopPrice` there is refused.
 */
export function readBracketFromBody(
  rec: Readonly<Record<string, unknown>>,
): { kind: 'bracket'; takeProfit: BracketLeg; stopLoss: BracketLeg } | { kind: 'oto'; close: BracketLeg } | null {
  if (rec.bracket !== true && rec.oto !== true) return null;
  if (rec.bracket === true && rec.oto === true) {
    throw new TradeError('an order is a bracket or an OTO, not both', 'trade.order_type_unsupported');
  }
  if (!clientKey(rec)) {
    throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
  }
  if (rec.oto === true) {
    const close = rec.close;
    if (close !== null && typeof close === 'object' && !Array.isArray(close) && Object.hasOwn(close, 'stopPrice')) {
      throw new TradeError('an OTO close is a limit price; a stop close is a bracket stop-loss', 'trade.order_type_unsupported');
    }
    return { kind: 'oto', close: asLeg(close) ?? { stopPrice: '' } };
  }
  return {
    kind: 'bracket',
    takeProfit: asLeg(rec.takeProfit) ?? { stopPrice: '' },
    stopLoss: asLeg(rec.stopLoss) ?? { stopPrice: '' },
  };
}

export function bindBracket(input: PlaceOrderInput): PlaceWithBracket {
  const extra = input as PlaceWithBracket;
  if (wantsBracket(extra) || wantsOto(extra)) return extra;
  const body = carriedPlacementBody(extra);
  const stashed = body === null ? null : readBracketFromBody(body);
  if (!stashed) return extra;
  if (stashed.kind === 'oto') return { ...extra, oto: true, close: stashed.close };
  return { ...extra, bracket: true, takeProfit: stashed.takeProfit, stopLoss: stashed.stopLoss };
}

/**
 * Bracket = an ordinary BUY entry, then one sell OCO for the base actually received.
 *
 * The engine's own bracket path rests the exits at entry fill with no hold behind them, so it is not used.
 * Here the exit is a normal order: its own base hold, placed after the entry fill is settled and the base is
 * in the account. Only an entry that resolves inside the request (market, IOC or FOK) is accepted: a resting
 * entry would fill later on someone else's request, when no caller identity exists to place the exit, and the
 * repo rule is never to mint one from a user id (a durable place grant is the follow-up).
 *
 * Crash safety: the exit prices are stored before the entry (trade.order_bracket_intent). If the exit fails
 * after the entry filled, the caller gets `trade.bracket_exit_failed` naming the entry, and a retry of the same
 * client order id replays the entry (idempotent) and places the exit with the same key.
 */
type BracketHost = {
  sql: import('postgres').Sql;
  placeOrder: (
    principal: Principal,
    input: PlaceOrderInput,
  ) => Promise<{ id: string; status: string; filledQty: bigint; marketId: string }>;
  requireMarket: (input: {
    symbol?: string;
    marketId?: string;
  }) => Promise<{ id: string; baseAsset: string; lotSize: Amount; tickSize: Amount }>;
  marketById: (id: string) => Promise<{ id: string; baseAsset: string; lotSize: Amount } | null>;
  cancelOrder: (principal: Principal, orderId: string) => Promise<{ status: string }>;
  now: () => Date;
};

/** What a sweep pass did. `unavailable` = an entry with fills whose stored grant was gone, so no exit was placed. */
export interface BracketSweepResult {
  readonly examined: number;
  readonly placed: number;
  readonly cancelledEntries: number;
  readonly unavailable: number;
  readonly failed: number;
}

export function exitClientOrderId(entryId: string): string {
  return `bracket:${entryId}:exit`;
}

export function otoCloseClientOrderId(entryId: string): string {
  return `oto:${entryId}:close`;
}

async function writeIntent(
  host: BracketHost,
  entryId: string,
  userId: string,
  kind: ExitKind,
  takeProfit: Amount,
  stopLoss: Amount | null,
  grant: { claims: ReturnType<typeof captureAlgoPlaceGrant>; expiresAt: Date } | null,
): Promise<void> {
  await host.sql`
    INSERT INTO trade.order_bracket_intent (order_id, user_id, kind, take_profit, stop_loss, grant_claims, grant_expires_at)
    VALUES (${entryId}, ${userId}, ${kind}, ${formatAmount(takeProfit)}::numeric,
            ${stopLoss === null ? null : formatAmount(stopLoss)}::numeric,
            ${grant ? host.sql.json(grant.claims as never) : null}, ${grant ? grant.expiresAt : null})
    ON CONFLICT (order_id) DO NOTHING
  `;
  const rows = await host.sql<Array<{ kind: string; take_profit: string; stop_loss: string | null }>>`
    SELECT kind, take_profit::text, stop_loss::text FROM trade.order_bracket_intent WHERE order_id = ${entryId}
  `;
  const stored = rows[0];
  const sameStop = stored?.stop_loss == null ? stopLoss === null : stopLoss !== null && parseAmount(stored.stop_loss) === stopLoss;
  const named = (k: string | undefined) => (k === 'oto' ? 'an OTO' : 'a bracket');
  if (!stored || stored.kind !== kind) {
    throw new TradeError(`clientOrderId was already used for ${named(stored?.kind)}, not ${named(kind)}`, 'trade.client_order_id_conflict');
  }
  if (parseAmount(stored.take_profit) !== takeProfit || !sameStop) {
    throw new TradeError(
      `clientOrderId was already used for ${named(stored.kind)} with different exit prices`,
      'trade.client_order_id_conflict',
    );
  }
}

// The only fields a plain entry carries. Anything else with a value (stopPx, trailing, peg, iceberg, AON, GTD
// expiry, auction, post-only, ...) can leave the entry resting or dormant, so no exit could be placed on its fill.
const PLAIN_ENTRY_FIELDS = new Set([
  'symbol',
  'marketId',
  'side',
  'type',
  'qty',
  'price',
  'tif',
  'clientOrderId',
  'subAccountId',
  'maxProtectionPrice',
  'minProtectionPrice',
  'bracket',
  'takeProfit',
  'stopLoss',
  'oto',
  'close',
]);

// The same allow-list over the request's own body, which travels on the input under a symbol: the inner installers
// (stop-limit, iceberg, post-only, ...) re-read their options from it, so a field only the body carries would still
// reach the engine even though the input itself looks plain.
const PLAIN_BODY_FIELDS = new Set([
  'symbol',
  'marketId',
  'side',
  'type',
  'amount',
  'qty',
  'price',
  'timeInForce',
  'tif',
  'clientOrderId',
  'subAccountId',
  'maxProtectionPrice',
  'minProtectionPrice',
  'bracket',
  'takeProfit',
  'stopLoss',
  'oto',
  'close',
]);

function firstExtra(rec: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): string | null {
  for (const [key, value] of Object.entries(rec)) {
    if (allowed.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    // The engine applies its one self-trade mode to every order (cancel the resting order, continue the incoming one),
    // so the desk saying it out loud on every order changes nothing about the entry. Any other mode is refused at the
    // place routes (refuseUnsupportedPlacementOptions).
    if (key === 'stpMode' && isEngineStpMode(value)) continue;
    return key;
  }
  return null;
}

export function deferredEntryField(input: PlaceOrderInput): string | null {
  if (input.type !== 'market' && input.type !== 'limit') return `type ${String(input.type)}`;
  const own = firstExtra(input as unknown as Record<string, unknown>, PLAIN_ENTRY_FIELDS);
  if (own !== null) return own;
  const body = carriedPlacementBody(input);
  if (body === null) return null;
  if (body.type !== undefined && body.type !== 'market' && body.type !== 'limit') return `type ${String(body.type)}`;
  return firstExtra(body, PLAIN_BODY_FIELDS);
}

/**
 * Place the exit for the base the entry actually received: a bracket's one sell OCO, or an OTO's one sell limit at its
 * close. Idempotent: the exit has a deterministic client order id and the intent records it. Returns true when an exit
 * exists afterwards.
 */
async function placeBracketExit(
  service: TradeService,
  principal: Principal,
  entryId: string,
  market: { id: string; baseAsset: string; lotSize: Amount },
  takeProfit: Amount,
  stopLoss: Amount | null,
): Promise<boolean> {
  const host = service as unknown as BracketHost;
  const done = await host.sql<Array<{ exit_order_id: string | null }>>`
    SELECT exit_order_id FROM trade.order_bracket_intent WHERE order_id = ${entryId}
  `;
  if (done[0]?.exit_order_id) return true;

  // Base received = filled qty minus fees charged in the base asset, floored to the lot grid.
  const got = await host.sql<Array<{ qty: string; fee: string }>>`
    SELECT COALESCE(SUM(qty), 0)::text AS qty,
           COALESCE(SUM(CASE WHEN fee_asset = ${market.baseAsset} THEN fee_amount ELSE 0 END), 0)::text AS fee
      FROM trade.fills WHERE order_id = ${entryId}
  `;
  const received = parseAmount(got[0]?.qty ?? '0') - parseAmount(got[0]?.fee ?? '0');
  const qty = received - (received % market.lotSize);
  if (qty <= ZERO) return false;

  try {
    // An OTO (no stop-loss) closes with a plain sell limit that rests until it fills or is cancelled.
    const exit = await service.placeOrder(
      principal,
      stopLoss === null
        ? ({
            marketId: market.id,
            side: 'sell',
            type: 'limit',
            qty,
            price: takeProfit,
            tif: 'GTC',
            clientOrderId: otoCloseClientOrderId(entryId),
          } as PlaceOrderInput)
        : ({
            marketId: market.id,
            side: 'sell',
            type: 'limit',
            qty,
            price: takeProfit,
            clientOrderId: exitClientOrderId(entryId),
            oco: true,
            takeProfit: { stopPrice: formatAmount(takeProfit) },
            stopLoss: { stopPrice: formatAmount(stopLoss) },
          } as PlaceOrderInput),
    );
    // Recorded only once it is live (resting or filled). An order whose submit is unknown, or that never reached the
    // book, is not an exit: the sweep keeps counting it failed until it is live or the grant runs out (surfaced).
    if (exit.status !== 'open' && exit.status !== 'filled') {
      throw new Error(`the ${stopLoss === null ? 'close' : 'exit'} ${exit.id} is ${exit.status}, not on the book`);
    }
    await host.sql`UPDATE trade.order_bracket_intent SET exit_order_id = ${exit.id} WHERE order_id = ${entryId}`;
    return true;
  } catch (err) {
    const what = stopLoss === null ? 'OTO entry' : 'bracket entry';
    const leg = stopLoss === null ? 'close' : 'exit';
    throw new TradeError(
      `the ${what} ${entryId} filled but its ${leg} could not be placed (${err instanceof Error ? err.message : String(err)}); retry the same request to place it`,
      'trade.bracket_exit_failed',
    );
  }
}

/** Stop sweeping an intent: it has no exit to place (nothing received) or no authority left to place one. */
async function closeGrant(host: BracketHost, entryId: string): Promise<void> {
  await host.sql`
    UPDATE trade.order_bracket_intent SET grant_claims = NULL, grant_expires_at = NULL
     WHERE order_id = ${entryId} AND exit_order_id IS NULL
  `;
}

/** One stored intent with a grant and no exit yet, joined to its entry's market and status. */
type IntentRow = {
  order_id: string;
  user_id: string;
  market_id: string;
  status: string;
  take_profit: string;
  stop_loss: string | null;
  grant_claims: unknown;
  grant_expires_at: Date;
};

/**
 * Work one stored intent with a grant and no exit yet: place the exit for a terminal entry as the grant's principal.
 * The sweep (`sweep`) also cancels a still-resting entry first (it runs near the grant's lapse) and closes the grant
 * when there is nothing to place or no authority left, which it counts and alerts on. A fill (`fill`) never cancels
 * and never touches a lapsed grant: those are left for the sweep, so nothing it finds goes uncounted. Either mode
 * closes the grant of a terminal entry that received nothing (no exit to place). Throws when the exit could not be placed.
 */
async function settleIntent(
  service: TradeService,
  row: IntentRow,
  mode: 'sweep' | 'fill',
): Promise<{ readonly placed: boolean; readonly cancelled: boolean; readonly unavailable: boolean }> {
  const host = service as unknown as BracketHost;
  const now = host.now();
  const grant = parseAlgoPlaceGrant(row.grant_claims);
  let principal: Principal | null = null;
  if (grant) {
    try {
      principal = principalFromAlgoGrant({ userId: row.user_id, grant, expiresAt: new Date(row.grant_expires_at), now });
    } catch {
      principal = null;
    }
  }
  if (principal === null) {
    if (mode === 'fill') return { placed: false, cancelled: false, unavailable: false };
    // Nothing to place with: counted once, then no longer swept. A resting entry past its grant can still fill
    // later with no exit, so it is surfaced too.
    await closeGrant(host, row.order_id);
    return { placed: false, cancelled: false, unavailable: true };
  }
  let cancelled = false;
  if (row.status === 'open' || row.status === 'pending') {
    if (mode === 'fill') return { placed: false, cancelled: false, unavailable: false };
    const after = await host.cancelOrder(principal, row.order_id);
    // A fill the engine matched just before the cancel is still settling: the entry stays open until it lands, and
    // an exit sized now would leave that quantity unprotected. The next sweep tries again.
    if (after.status === 'open' || after.status === 'pending') return { placed: false, cancelled: false, unavailable: false };
    cancelled = true;
  }
  const market = await host.marketById(row.market_id);
  if (!market) return { placed: false, cancelled, unavailable: false };
  const stopLoss = row.stop_loss === null ? null : parseAmount(row.stop_loss);
  if (await placeBracketExit(service, principal, row.order_id, market, parseAmount(row.take_profit), stopLoss)) {
    return { placed: true, cancelled, unavailable: false };
  }
  // Terminal with nothing received: nothing to protect, stop sweeping it.
  await closeGrant(host, row.order_id);
  return { placed: false, cancelled, unavailable: false };
}

/**
 * Sweep the bracket entries that were accepted to rest. For each intent with a stored grant and no exit yet:
 *  · the entry is terminal → place the exit for the base received, as the stored grant's principal;
 *  · the entry still rests and the grant lapses within `graceMs` → cancel the entry (then place the exit for any
 *    part that filled), so no entry outlives the authority to protect it;
 *  · the grant is already gone → place nothing and count it: a filled entry with no exit is surfaced, never
 *    covered by minting a principal from a user id.
 */
async function sweepBracketExits(service: TradeService, graceMs: number, limit = 50): Promise<BracketSweepResult> {
  const host = service as unknown as BracketHost;
  let examined = 0;
  let placed = 0;
  let cancelledEntries = 0;
  let unavailable = 0;
  let failed = 0;
  let cursor = '00000000-0000-0000-0000-000000000000';
  const horizon = new Date(host.now().getTime() + graceMs);
  for (;;) {
    // Only rows with something to do: a terminal entry, or a resting one whose grant lapses within the grace
    // window (or already has). A resting entry far from its lapse stays out of the window, so it can never crowd
    // out a later entry that has filled. Paged by order id so no row is starved by the ones before it.
    const rows = await host.sql<IntentRow[]>`
      SELECT i.order_id, i.user_id, o.market_id, o.status, i.take_profit::text, i.stop_loss::text, i.grant_claims, i.grant_expires_at
        FROM trade.order_bracket_intent i
        JOIN trade.orders o ON o.id = i.order_id
       WHERE i.exit_order_id IS NULL AND i.grant_claims IS NOT NULL
         AND i.order_id > ${cursor}
         AND o.status NOT IN ('recovery_required', 'hold_unknown')
         AND (o.status NOT IN ('open', 'pending') OR i.grant_expires_at <= ${horizon})
       ORDER BY i.order_id
       LIMIT ${limit}
    `;
    for (const row of rows) {
      cursor = row.order_id;
      examined += 1;
      try {
        const outcome = await settleIntent(service, row, 'sweep');
        if (outcome.unavailable) unavailable += 1;
        if (outcome.cancelled) cancelledEntries += 1;
        if (outcome.placed) placed += 1;
      } catch {
        failed += 1;
      }
    }
    if (rows.length < limit) break;
  }
  return { examined, placed, cancelledEntries, unavailable, failed };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The fills just settled may have ended a resting OTO or bracket entry: place its exit now, not at the next sweep
 * ("the close fires when the entry fills"). Only entries the fills made terminal are worked; a still-resting or
 * part-filled entry waits. Best effort and never throws: an exit it could not place is placed (or alerted) by the sweep.
 */
async function placeExitsAfterFills(service: TradeService, orderIds: readonly string[]): Promise<void> {
  const ids = [...new Set(orderIds.filter((id) => UUID.test(id)))];
  if (ids.length === 0) return;
  const host = service as unknown as BracketHost;
  try {
    const rows = await host.sql<IntentRow[]>`
      SELECT i.order_id, i.user_id, o.market_id, o.status, i.take_profit::text, i.stop_loss::text, i.grant_claims, i.grant_expires_at
        FROM trade.order_bracket_intent i
        JOIN trade.orders o ON o.id = i.order_id
       WHERE i.order_id IN ${host.sql(ids)}
         AND i.exit_order_id IS NULL AND i.grant_claims IS NOT NULL
         AND o.status NOT IN ('open', 'pending', 'recovery_required', 'hold_unknown')
    `;
    for (const row of rows) {
      try {
        await settleIntent(service, row, 'fill');
      } catch {
        // Left for the sweep, which retries and alerts.
      }
    }
  } catch {
    // Left for the sweep.
  }
}

export function installBracketPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string; rejectCode?: string }>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  (proto as unknown as { sweepBracketExits: (graceMs: number, limit?: number) => Promise<BracketSweepResult> }).sweepBracketExits =
    function (this: TradeService, graceMs: number, limit?: number) {
      return sweepBracketExits(this, graceMs, limit);
    };

  // A resting entry that a fill ends gets its exit at once, whichever path settled the fill: the taker's own request
  // (settleOutcome) or the matching event (settleFillEvent). The sweep stays the backstop.
  const settling = proto as unknown as {
    settleOutcome: (
      market: unknown,
      fills: readonly { makerOrderId: string; takerOrderId: string }[],
      cancellations: unknown,
    ) => Promise<void>;
    settleFillEvent: (input: { makerOrderId: string; takerOrderId: string }) => Promise<void>;
  };
  const origSettleOutcome = settling.settleOutcome;
  settling.settleOutcome = async function (this: TradeService, market, fills, cancellations) {
    await origSettleOutcome.call(this, market, fills, cancellations);
    if (fills.length > 0)
      await placeExitsAfterFills(
        this,
        fills.flatMap((fill) => [fill.makerOrderId, fill.takerOrderId]),
      );
  };
  const origSettleFillEvent = settling.settleFillEvent;
  settling.settleFillEvent = async function (this: TradeService, input) {
    await origSettleFillEvent.call(this, input);
    await placeExitsAfterFills(this, [input.makerOrderId, input.takerOrderId]);
  };

  // A replacement is a new order under a new id: the intent stays with the cancelled entry and its exit would never
  // be placed. An entry whose exit is still to come is therefore cancelled and placed again, never replaced.
  const changing = proto as unknown as {
    replaceOrder: (principal: Principal, originalOrderId: string, input: PlaceOrderInput) => Promise<unknown>;
  };
  const origReplace = changing.replaceOrder;
  changing.replaceOrder = async function (this: TradeService, principal: Principal, originalOrderId: string, input: PlaceOrderInput) {
    if (UUID.test(originalOrderId)) {
      const host = this as unknown as BracketHost;
      const [pending] = await host.sql<Array<{ kind: string }>>`
        SELECT kind FROM trade.order_bracket_intent WHERE order_id = ${originalOrderId} AND user_id = ${principal.userId} AND exit_order_id IS NULL
      `;
      if (pending) {
        throw new TradeError(
          `${pending.kind === 'oto' ? 'an OTO' : 'a bracket'} entry carries an exit that is placed when it fills; cancel it and place it again`,
          'trade.order_type_unsupported',
        );
      }
    }
    return origReplace.call(this, principal, originalOrderId, input);
  };

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindBracket(input);
    const oto = wantsOto(bound);
    if (!wantsBracket(bound) && !oto) return origPlace.call(this, principal, bound);
    const kind: ExitKind = oto ? 'oto' : 'bracket';
    const name = oto ? 'an OTO' : 'a bracket';
    const missingEntry = entryRefuse(bound, name);
    if (missingEntry) throw missingEntry;
    // An OTO's close is judged against the price its entry pays, so the entry is a limit; a market buy has none.
    if (oto && bound.type !== 'limit') {
      throw new TradeError('an OTO entry is a limit buy: its close is judged against the entry price', 'trade.order_type_unsupported');
    }
    const takeProfit = triggerOf(oto ? bound.close : bound.takeProfit);
    if (oto && takeProfit === null) {
      throw new TradeError('an OTO close price is missing; trade does not invent one', 'trade.missing_price');
    }
    const missingTp = takeProfitRefuse(takeProfit);
    if (missingTp) throw missingTp;
    const stopLoss = oto ? null : triggerOf(bound.stopLoss);
    const missingSl = oto ? null : stopLossRefuse(stopLoss);
    if (missingSl) throw missingSl;
    if (bound.side !== 'buy') {
      throw new TradeError(`${name} entry must be a buy for now`, 'trade.order_type_unsupported');
    }
    const deferred = deferredEntryField(bound);
    if (deferred !== null) {
      throw new TradeError(
        `${name} entry must resolve inside the request or rest as a plain limit: ${deferred} defers or conditions execution`,
        'trade.order_type_unsupported',
      );
    }
    // An entry that can rest fills later, on someone else's request, when no caller identity exists to place the exit.
    // It is accepted only with a stored place grant (the caller's own claims, expiring with the caller's credential),
    // and the sweep cancels the entry before that grant lapses so no entry can fill into a position whose exit
    // could not be placed.
    // Only `bound.tif` can matter: the entry is placed with the carried request body dropped, so no alias in it
    // reaches the engine.
    const resting = bound.type === 'limit' && bound.tif !== 'IOC' && bound.tif !== 'FOK';
    if (resting) {
      if (!principal.scopes.includes('trade:write')) {
        throw new TradeError(
          `a resting ${oto ? 'OTO' : 'bracket'} entry needs trade:write to store a place grant`,
          'trade.order_type_unsupported',
        );
      }
      if (!(principal.expiresAt instanceof Date) || principal.expiresAt.getTime() <= (this as unknown as BracketHost).now().getTime()) {
        throw new TradeError(
          `a resting ${oto ? 'OTO' : 'bracket'} entry needs a credential with a known, future expiry to store a place grant`,
          'trade.order_type_unsupported',
        );
      }
    }
    if (stopLoss !== null && (takeProfit as Amount) <= stopLoss) {
      throw new TradeError('a bracket take-profit must be above its stop-loss', 'trade.invalid_price');
    }
    // An OTO close sells what the entry bought: at or under a priced entry it would sell straight back at no gain.
    const entryPrice = readEntry(bound);
    if (oto && entryPrice !== null && (takeProfit as Amount) <= entryPrice) {
      throw new TradeError('an OTO close must be above its entry price', 'trade.invalid_price');
    }

    const host = this as unknown as BracketHost;
    const market = await host.requireMarket({ symbol: bound.symbol, marketId: bound.marketId });
    // The exit is placed later with no caller present: a price off the market's grid would be refused then, leaving the
    // bought base with no exit. It is refused now, before anything is held.
    const offGrid = (price: Amount | null) => price !== null && market.tickSize > ZERO && price % market.tickSize !== ZERO;
    if (offGrid(takeProfit) || offGrid(stopLoss)) {
      throw new TradeError(`${name} ${oto ? 'close' : 'exit'} price must be a whole number of price steps`, 'trade.invalid_price');
    }
    const clientOrderId = bound.clientOrderId as string;
    const entryId = orderIdFor(principal.userId, market.id, clientOrderId);
    await writeIntent(
      host,
      entryId,
      principal.userId,
      kind,
      takeProfit as Amount,
      stopLoss,
      resting ? { claims: captureAlgoPlaceGrant(principal), expiresAt: principal.expiresAt } : null,
    );

    // The entry is an ordinary order: the exit fields never reach it or the engine.
    const { bracket: _b, takeProfit: _tp, stopLoss: _sl, oto: _oto, close: _close, ...entryInput } = bound;
    // The request body is dropped from the entry: the inner installers must not re-read an option (an alias such as
    // tif: 'PO') from it, so the entry is exactly the typed input this guard has checked.
    const entry = await origPlace.call(this, principal, withoutCarriedBody(entryInput as PlaceOrderInput));

    // An entry still resting is not sized yet: its exit is placed by the sweep once the entry is terminal.
    if (entry.status === 'open' || entry.status === 'pending') return entry;
    // An unresolved entry (no verdict yet) may still fill: sizing an exit now would leave later fills unprotected.
    // The caller retries the same request once it resolves.
    if (entry.status === 'recovery_required' || entry.status === 'hold_unknown') return entry;
    await placeBracketExit(this, principal, entryId, market, takeProfit as Amount, stopLoss);
    return entry;
  };
}

installBracketPlace(TradeService);
