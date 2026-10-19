/**
 * Place a linked bracket with entry, take-profit, and stop-loss through matching (#3658).
 * One submit. Entry fill rests the exits. Refuse if any leg is missing.
 * Trade does not invent a trigger.
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 * Not a redo of #3658 (matching rest) or #3634 (OCO place).
 */
import type { Principal } from '@intafaced/auth';
import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { carriedPlacementBody } from './placement-extras.js';
import { orderIdFor } from './ids.js';

export type BracketLeg = {
  readonly price?: string;
  readonly stopPrice: string;
};

export type PlaceWithBracket = PlaceOrderInput & {
  bracket?: boolean;
  takeProfit?: Amount | BracketLeg | string | null;
  stopLoss?: Amount | BracketLeg | string | null;
};

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

export function readEntry(order: { readonly type?: string; readonly price?: Amount | null }): Amount | null {
  if (order.type === 'market') return null;
  if (order.price === undefined || order.price === null || order.price <= ZERO) return null;
  return order.price;
}

export function entryRefuse(order: { readonly type?: string; readonly price?: Amount | null }): TradeError | null {
  if (order.type === 'market') return null;
  if (readEntry(order) !== null) return null;
  return new TradeError('a bracket entry is missing; trade does not invent a trigger', 'trade.missing_price');
}

export function takeProfitRefuse(takeProfit: Amount | null): TradeError | null {
  if (takeProfit !== null) return null;
  return new TradeError('a bracket take-profit is missing; trade does not invent a trigger', 'trade.missing_stop_price');
}

export function stopLossRefuse(stopLoss: Amount | null): TradeError | null {
  if (stopLoss !== null) return null;
  return new TradeError('a bracket stop-loss is missing; trade does not invent a trigger', 'trade.missing_stop_price');
}

/** The legs this request's own body asks for, or null when it is not a bracket. Refuses what it cannot read. */
export function readBracketFromBody(rec: Readonly<Record<string, unknown>>): { takeProfit: BracketLeg; stopLoss: BracketLeg } | null {
  if (rec.bracket !== true) return null;
  if (!clientKey(rec)) {
    throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
  }
  return {
    takeProfit: asLeg(rec.takeProfit) ?? { stopPrice: '' },
    stopLoss: asLeg(rec.stopLoss) ?? { stopPrice: '' },
  };
}

export function bindBracket(input: PlaceOrderInput): PlaceWithBracket {
  const extra = input as PlaceWithBracket;
  if (wantsBracket(extra)) return extra;
  const body = carriedPlacementBody(extra);
  const stashed = body === null ? null : readBracketFromBody(body);
  if (!stashed) return extra;
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
  requireMarket: (input: { symbol?: string; marketId?: string }) => Promise<{ id: string; baseAsset: string; lotSize: Amount }>;
};

export function exitClientOrderId(entryId: string): string {
  return `bracket:${entryId}:exit`;
}

async function writeIntent(host: BracketHost, entryId: string, userId: string, takeProfit: Amount, stopLoss: Amount): Promise<void> {
  await host.sql`
    INSERT INTO trade.order_bracket_intent (order_id, user_id, take_profit, stop_loss)
    VALUES (${entryId}, ${userId}, ${formatAmount(takeProfit)}::numeric, ${formatAmount(stopLoss)}::numeric)
    ON CONFLICT (order_id) DO NOTHING
  `;
  const rows = await host.sql<Array<{ take_profit: string; stop_loss: string }>>`
    SELECT take_profit::text, stop_loss::text FROM trade.order_bracket_intent WHERE order_id = ${entryId}
  `;
  const stored = rows[0];
  if (!stored || parseAmount(stored.take_profit) !== takeProfit || parseAmount(stored.stop_loss) !== stopLoss) {
    throw new TradeError('clientOrderId was already used for a bracket with different exit prices', 'trade.client_order_id_conflict');
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
]);

export function deferredEntryField(input: PlaceOrderInput): string | null {
  if (input.type !== 'market' && input.type !== 'limit') return `type ${String(input.type)}`;
  for (const [key, value] of Object.entries(input)) {
    if (PLAIN_ENTRY_FIELDS.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    return key;
  }
  return null;
}

export function installBracketPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string; rejectCode?: string }>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindBracket(input);
    if (!wantsBracket(bound)) return origPlace.call(this, principal, bound);
    const missingEntry = entryRefuse(bound);
    if (missingEntry) throw missingEntry;
    const takeProfit = triggerOf(bound.takeProfit);
    const missingTp = takeProfitRefuse(takeProfit);
    if (missingTp) throw missingTp;
    const stopLoss = triggerOf(bound.stopLoss);
    const missingSl = stopLossRefuse(stopLoss);
    if (missingSl) throw missingSl;
    if (bound.side !== 'buy') {
      throw new TradeError('a bracket entry must be a buy for now', 'trade.order_type_unsupported');
    }
    const deferred = deferredEntryField(bound);
    if (deferred !== null) {
      throw new TradeError(
        `a bracket entry must resolve inside the request: ${deferred} defers or conditions execution`,
        'trade.order_type_unsupported',
      );
    }
    if (bound.type !== 'market' && bound.tif !== 'IOC' && bound.tif !== 'FOK') {
      throw new TradeError(
        'a bracket entry must be market, IOC or FOK for now: a resting entry needs a stored place grant to place its exit',
        'trade.order_type_unsupported',
      );
    }
    if ((takeProfit as Amount) <= (stopLoss as Amount)) {
      throw new TradeError('a bracket take-profit must be above its stop-loss', 'trade.invalid_price');
    }

    const host = this as unknown as BracketHost;
    const market = await host.requireMarket({ symbol: bound.symbol, marketId: bound.marketId });
    const clientOrderId = bound.clientOrderId as string;
    const entryId = orderIdFor(principal.userId, market.id, clientOrderId);
    await writeIntent(host, entryId, principal.userId, takeProfit as Amount, stopLoss as Amount);

    // The entry is an ordinary order: the exit fields never reach it or the engine.
    const { bracket: _b, takeProfit: _tp, stopLoss: _sl, ...entryInput } = bound;
    const entry = await origPlace.call(this, principal, entryInput as PlaceOrderInput);

    const done = await host.sql<Array<{ exit_order_id: string | null }>>`
      SELECT exit_order_id FROM trade.order_bracket_intent WHERE order_id = ${entryId}
    `;
    if (done[0]?.exit_order_id) return entry;

    // Base received = filled qty minus fees charged in the base asset, floored to the lot grid.
    const got = await host.sql<Array<{ qty: string; fee: string }>>`
      SELECT COALESCE(SUM(qty), 0)::text AS qty,
             COALESCE(SUM(CASE WHEN fee_asset = ${market.baseAsset} THEN fee_amount ELSE 0 END), 0)::text AS fee
        FROM trade.fills WHERE order_id = ${entryId}
    `;
    const received = parseAmount(got[0]?.qty ?? '0') - parseAmount(got[0]?.fee ?? '0');
    const qty = received - (received % market.lotSize);
    if (qty <= ZERO) return entry;

    try {
      const exit = await this.placeOrder(principal, {
        marketId: market.id,
        side: 'sell',
        type: 'limit',
        qty,
        price: takeProfit as Amount,
        clientOrderId: exitClientOrderId(entryId),
        oco: true,
        takeProfit: { stopPrice: formatAmount(takeProfit as Amount) },
        stopLoss: { stopPrice: formatAmount(stopLoss as Amount) },
      } as PlaceOrderInput);
      await host.sql`UPDATE trade.order_bracket_intent SET exit_order_id = ${exit.id} WHERE order_id = ${entryId}`;
    } catch (err) {
      throw new TradeError(
        `the bracket entry ${entryId} filled but its exit could not be placed (${err instanceof Error ? err.message : String(err)}); retry the same request to place it`,
        'trade.bracket_exit_failed',
      );
    }
    return entry;
  };
}

installBracketPlace(TradeService);
