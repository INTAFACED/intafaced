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
import { carriedPlacementBody, withoutCarriedBody } from './placement-extras.js';
import { orderIdFor } from './ids.js';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';

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

async function writeIntent(
  host: BracketHost,
  entryId: string,
  userId: string,
  takeProfit: Amount,
  stopLoss: Amount,
  grant: { claims: ReturnType<typeof captureAlgoPlaceGrant>; expiresAt: Date } | null,
): Promise<void> {
  await host.sql`
    INSERT INTO trade.order_bracket_intent (order_id, user_id, take_profit, stop_loss, grant_claims, grant_expires_at)
    VALUES (${entryId}, ${userId}, ${formatAmount(takeProfit)}::numeric, ${formatAmount(stopLoss)}::numeric,
            ${grant ? host.sql.json(grant.claims as never) : null}, ${grant ? grant.expiresAt : null})
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
]);

function firstExtra(rec: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): string | null {
  for (const [key, value] of Object.entries(rec)) {
    if (allowed.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
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
 * Place the one sell OCO for the base the entry actually received. Idempotent: the exit has a deterministic client
 * order id and the intent records it. Returns true when an exit exists afterwards.
 */
async function placeBracketExit(
  service: TradeService,
  principal: Principal,
  entryId: string,
  market: { id: string; baseAsset: string; lotSize: Amount },
  takeProfit: Amount,
  stopLoss: Amount,
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
    const exit = await service.placeOrder(principal, {
      marketId: market.id,
      side: 'sell',
      type: 'limit',
      qty,
      price: takeProfit,
      clientOrderId: exitClientOrderId(entryId),
      oco: true,
      takeProfit: { stopPrice: formatAmount(takeProfit) },
      stopLoss: { stopPrice: formatAmount(stopLoss) },
    } as PlaceOrderInput);
    await host.sql`UPDATE trade.order_bracket_intent SET exit_order_id = ${exit.id} WHERE order_id = ${entryId}`;
    return true;
  } catch (err) {
    throw new TradeError(
      `the bracket entry ${entryId} filled but its exit could not be placed (${err instanceof Error ? err.message : String(err)}); retry the same request to place it`,
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
  const rows = await host.sql<
    Array<{
      order_id: string;
      user_id: string;
      market_id: string;
      status: string;
      take_profit: string;
      stop_loss: string;
      grant_claims: unknown;
      grant_expires_at: Date;
    }>
  >`
    SELECT i.order_id, i.user_id, o.market_id, o.status, i.take_profit::text, i.stop_loss::text, i.grant_claims, i.grant_expires_at
      FROM trade.order_bracket_intent i
      JOIN trade.orders o ON o.id = i.order_id
     WHERE i.exit_order_id IS NULL AND i.grant_claims IS NOT NULL
     ORDER BY i.created_at
     LIMIT ${limit}
  `;
  let placed = 0;
  let cancelledEntries = 0;
  let unavailable = 0;
  let failed = 0;
  for (const row of rows) {
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
    const resting = row.status === 'open' || row.status === 'pending';
    if (principal === null) {
      // Nothing to place with. Only worth an alert when the entry actually bought something.
      if (!resting) {
        unavailable += 1;
        await closeGrant(host, row.order_id);
      }
      continue;
    }
    try {
      if (resting) {
        if (new Date(row.grant_expires_at).getTime() - now.getTime() > graceMs) continue;
        await host.cancelOrder(principal, row.order_id);
        cancelledEntries += 1;
      } else if (row.status === 'recovery_required' || row.status === 'hold_unknown') {
        continue;
      }
      const market = await host.marketById(row.market_id);
      if (!market) continue;
      if (await placeBracketExit(service, principal, row.order_id, market, parseAmount(row.take_profit), parseAmount(row.stop_loss))) {
        placed += 1;
      } else if (!resting) {
        // Terminal with nothing received: nothing to protect, stop sweeping it.
        await closeGrant(host, row.order_id);
      }
    } catch {
      failed += 1;
    }
  }
  return { examined: rows.length, placed, cancelledEntries, unavailable, failed };
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
    // An entry that can rest fills later, on someone else's request, when no caller identity exists to place the exit.
    // It is accepted only with a stored place grant (the caller's own claims, expiring with the caller's credential),
    // and the sweep cancels the entry before that grant lapses so no entry can fill into a position whose exit
    // could not be placed.
    const resting = bound.type === 'limit' && bound.tif !== 'IOC' && bound.tif !== 'FOK';
    if (resting) {
      if (!principal.scopes.includes('trade:write')) {
        throw new TradeError('a resting bracket entry needs trade:write to store a place grant', 'trade.order_type_unsupported');
      }
      if (!(principal.expiresAt instanceof Date) || principal.expiresAt.getTime() <= (this as unknown as BracketHost).now().getTime()) {
        throw new TradeError(
          'a resting bracket entry needs a credential with a known, future expiry to store a place grant',
          'trade.order_type_unsupported',
        );
      }
    }
    if ((takeProfit as Amount) <= (stopLoss as Amount)) {
      throw new TradeError('a bracket take-profit must be above its stop-loss', 'trade.invalid_price');
    }

    const host = this as unknown as BracketHost;
    const market = await host.requireMarket({ symbol: bound.symbol, marketId: bound.marketId });
    const clientOrderId = bound.clientOrderId as string;
    const entryId = orderIdFor(principal.userId, market.id, clientOrderId);
    await writeIntent(
      host,
      entryId,
      principal.userId,
      takeProfit as Amount,
      stopLoss as Amount,
      resting ? { claims: captureAlgoPlaceGrant(principal), expiresAt: principal.expiresAt } : null,
    );

    // The entry is an ordinary order: the exit fields never reach it or the engine.
    const { bracket: _b, takeProfit: _tp, stopLoss: _sl, ...entryInput } = bound;
    // The request body is dropped from the entry: the inner installers must not re-read an option (an alias such as
    // tif: 'PO') from it, so the entry is exactly the typed input this guard has checked.
    const entry = await origPlace.call(this, principal, withoutCarriedBody(entryInput as PlaceOrderInput));

    // An entry still resting is not sized yet: its exit is placed by the sweep once the entry is terminal.
    if (entry.status === 'open' || entry.status === 'pending') return entry;
    await placeBracketExit(this, principal, entryId, market, takeProfit as Amount, stopLoss as Amount);
    return entry;
  };
}

installBracketPlace(TradeService);
