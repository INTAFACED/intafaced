/**
 * Applying what the engine said: submit results, OCO legs, fills and their settlement, and the notices a fill sends.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import type { EventBus } from '@intafaced/events';
import { formatAmount, makerRebateFor, mul, mulBps, parseAmount, recipes, type Amount, type PostRequest } from '@intafaced/ledger-client';
import { fillIdFor, fillLegIdFor } from '../ids.js';
import { ocoLegParent, settlementOrderId } from '../oco-legs.js';
import { type FillRow } from '../rows.js';
import { fireAffiliateAccrue, affiliateLegsAfterFill } from '../affiliate-accrue.js';
import { fireAffiliatePayout } from '../affiliate-payout.js';
import { dropCopySourceForBookOrder, fireDropCopyFill, type DropCopyFillWire, type DropCopyHitchSource } from '../drop-copy-ingest.js';
import { type EngineCancellation, type EngineFill, type EngineSubmitResult, type MatchingClient } from '../matching-client.js';
import { isHouseMmAccount } from '../../mm/seed-market.js';
import { HOUSE_MM_USER_UUID } from '../ids.js';
import { REGULAR_FEE_TIER } from '../fee-schedule.js';
import { settleIfcLeg, type IfcLegDecision } from '../fee-ifc.js';
import {
  attributionFromOrder,
  houseMmAttribution,
  requireAuthAttribution,
  withFillLedgerAttribution,
  withLedgerAttribution,
  type AuthAttribution,
} from '../auth-attribution.js';
import { TradeError, type Market, type OrderRecord } from '../types.js';
import { BUYBACK_HOUSE_MAKER, BUYBACK_INVALID, buybackAttribution, isBuybackUser } from '../buyback-order.js';
import type { TradeServiceInternal } from '../trade-service.js';

/** `TradeService` as the functions here that publish see it: they publish on its `@intafaced/events` bus. */
type PublishingService = TradeServiceInternal & { readonly bus: EventBus };

// ── Applying what the engine said ─────────────────────────────────────────
export async function applySubmitResult(
  svc: TradeServiceInternal,
  market: Market,
  orderId: string,
  result: EngineSubmitResult,
): Promise<void> {
  if (!result.accepted) {
    // H8c: matching already accepted this orderId (200 then trade death).
    // Retry is duplicate_order_id with empty fills — not a reject. Releasing
    // would unfund a live rest. Hold stays; fills arrive on the bus.
    if (result.rejected?.code === 'duplicate_order_id') {
      return;
    }
    // A rejection is a valid answer, not a fault: post-only refusing to cross
    // is the feature working. The order never touched the book, so the whole
    // hold comes straight back.
    //
    // The reject code is recorded first because it carries no money; the
    // release and the terminal status are done together by `finalize`, in
    // that order, for the reason spelled out there.
    await svc.sql`
      UPDATE trade.orders SET reject_code = ${result.rejected?.code ?? 'rejected'}, updated_at = now() WHERE id = ${orderId}
    `;
    await svc.finalize(orderId, 'rejected');
    return;
  }

  const accepted = await svc.findOrder(orderId);
  if (accepted) {
    await svc.noteOrderEvent(accepted, 'ack', 'ack');
    if (result.resting?.orderId === orderId) await svc.noteOrderEvent(accepted, 'rest', 'rest');
  }

  if (result.sequence !== null || result.resting?.version != null) {
    const version = result.resting?.version ?? 1;
    await svc.sql`
      UPDATE trade.orders
         SET engine_sequence = COALESCE(${result.sequence}, engine_sequence),
             engine_version = ${version},
             updated_at = now()
       WHERE id = ${orderId}
    `;
  }

  // A triggered stop cannot occur while this service refuses stop orders, but
  // the outcome is flattened rather than ignored: if the engine ever reports
  // one, the fills and cancellations inside it settle exactly like any other,
  // instead of being silently dropped along with somebody's money.
  const fills: EngineFill[] = [...result.fills];
  const cancellations: EngineCancellation[] = [...result.cancellations];
  for (const triggered of result.triggered) {
    fills.push(...triggered.fills);
    cancellations.push(...triggered.cancellations);
  }

  await svc.settleOutcome(market, fills, cancellations);

  // The submitted order rested with a remainder → it stays open, holding the
  // rest of its funds. It did not rest → it is done, and whatever is left of
  // the hold goes back now rather than at some future sweep.
  if (result.resting === null || result.resting.orderId !== orderId) {
    await svc.finalizeIfComplete(orderId);
  }
}

/**
 * Settle one submission's fills and cancellations, in that order.
 *
 * Fills first, always. A cancellation releases `hold - consumed`, and
 * `consumed` is derived from the fills table — so releasing before the fills
 * are recorded would hand back money a fill is about to spend.
 */
export async function settleOutcome(
  svc: TradeServiceInternal,
  market: Market,
  fills: readonly EngineFill[],
  cancellations: readonly EngineCancellation[],
): Promise<void> {
  const touched = new Set<string>();

  for (const fill of [...fills].sort((a, b) => a.sequence - b.sequence)) {
    await svc.settleFill(market, fill);
    touched.add(settlementOrderId(fill.makerOrderId));
    touched.add(settlementOrderId(fill.takerOrderId));
  }

  // An IOC remainder, a market remainder, or a resting order pulled by
  // self-trade prevention. §5.1 unifies them because this service does the
  // same thing with all three: the order is done, release what is left.
  for (const cancellation of cancellations) {
    await svc.recordOcoLegEnd(cancellation.orderId, cancellation.remainingQty, cancellation.reason);
    await svc.finalize(cancellation.orderId, 'cancelled', cancellation.reason);
    // A leg cancellation may leave the parent open (fail closed), so only an ordinary order leaves `touched`.
    if (ocoLegParent(cancellation.orderId) === null) touched.delete(cancellation.orderId);
  }

  // A maker that filled completely leaves the book without a cancellation —
  // it simply is not there any more. It still has a hold to close out: a buy
  // was funded at `ceil(price x qty)` and consumed `sum(floor(price x qty_i))`,
  // so a wei of rounding can be left behind. Left behind is exactly what it
  // must not be.
  for (const id of touched) await svc.finalizeIfComplete(id);
}

/**
 * One OCO leg left the book. The parent's single hold funds BOTH legs, so it may be released only when no leg
 * is left resting. The engine cancels the sibling on ANY first fill, so a partly filled take-profit keeps
 * resting on the rest of the hold while its stop-loss sibling is cancelled: releasing here would leave that
 * leg on the book without funds. Fails closed: if the engine cannot say the other leg is gone, the hold stays
 * and a later leg event (or the fill that completes the order) closes it.
 * Returns true when the parent was closed.
 */
export async function finalizeOcoWhenNoLegLive(
  svc: TradeServiceInternal,
  marketId: string,
  legId: string,
  reason: string | null | undefined,
  status: 'cancelled' | 'expired',
): Promise<boolean> {
  const parentId = ocoLegParent(legId);
  if (parentId === null) return false;
  let listed: Awaited<ReturnType<MatchingClient['listOrders']>>;
  try {
    listed = await svc.matching.listOrders(marketId);
  } catch {
    return false;
  }
  const live = new Set(listed.orders.map((row) => row.orderId));
  if (live.has(`${parentId}:tp`) || live.has(`${parentId}:sl`)) return false;
  // A leg that left the book without a cancellation FILLED completely, and a fill the engine has printed may
  // not be settled here yet (a second taker can take the last of a leg before the first taker's settlement runs).
  // Release only when the settled fills cover everything the legs executed; otherwise the hold stays and the
  // late fill's own settlement closes the order (filled, or through the next leg event).
  if (!(await svc.ocoExecutionSettled(parentId))) return false;
  await svc.finalize(parentId, status, reason);
  return true;
}

/** Remember how much of an OCO leg the engine had NOT executed when it cancelled the leg. Idempotent. */
export async function recordOcoLegEnd(
  svc: TradeServiceInternal,
  legId: string,
  remainingQty: string,
  reason?: string | null,
): Promise<void> {
  const parentId = ocoLegParent(legId);
  if (parentId === null) return;
  const leg = legId.endsWith(':tp') ? 'tp' : 'sl';
  await svc.sql`
    INSERT INTO trade.oco_leg_end (parent_id, leg, remaining_qty, reason)
    VALUES (${parentId}, ${leg}, ${remainingQty}, ${reason ?? null})
    ON CONFLICT (parent_id, leg) DO NOTHING
  `;
}

/**
 * True when the parent's settled fills cover what its legs executed. By default both legs must have a recorded
 * end: a leg with none is gone because it filled, and its last fill may be unsettled. Fails closed. A caller
 * that has itself just pulled the resting legs passes `requireBothLegs: false`: a leg with no record is then the
 * sibling the engine cancelled unfilled on a first fill, which executed nothing.
 */
export async function ocoExecutionSettled(
  svc: TradeServiceInternal,
  parentId: string,
  opts: { requireBothLegs?: boolean },
): Promise<boolean> {
  const parent = await svc.findOrder(parentId);
  if (!parent) return false;
  const ends = await svc.sql<Array<{ leg: string; remaining_qty: string }>>`
    SELECT leg, remaining_qty::text AS remaining_qty FROM trade.oco_leg_end WHERE parent_id = ${parentId}
  `;
  if (ends.length < 2 && opts.requireBothLegs !== false) return false;
  let executed = 0n;
  for (const end of ends) executed += parent.qty - parseAmount(end.remaining_qty);
  return parent.filledQty >= executed;
}

/**
 * Turn one match into one `tradeFill` ledger transaction (§5.2 step 3).
 *
 * ORDERING — the rows are committed BEFORE the ledger post, which is the
 * opposite of the order svc-token uses for a stake, and deliberately so. The
 * amount still owed back to a user is derived as `hold - Σ fills`, so:
 *
 *   · rows first  → the fills table can only ever be AHEAD of the ledger, so
 *                   `consumed` is never understated, so a release is never
 *                   overstated. Worst case a fill is recorded but unsettled:
 *                   the funds stay in `hold`, nothing is lost, and re-running
 *                   this method re-posts the same idempotency key and heals it.
 *   · ledger first→ a crash before the row is written understates `consumed`,
 *                   and the next release hands back money this fill already
 *                   spent — drawn out of whatever else that user has in
 *                   `hold`. That is one order silently paying for another.
 *
 * Idempotent at both layers: the ledger key is `trade.fill:<fillId>` where
 * `fillId` derives from (market, engine sequence), and the unique index on
 * (market, sequence, liquidity) makes a second row impossible.
 */
/**
 * Write one leg of a fill, and decide what a collision MEANS before absorbing it.
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 *
 * `trade.fills` carries TWO unique keys: `fills_pkey` on `id`, and
 * `fills_market_sequence_role_idx` on `(market_id, sequence, liquidity)`. The
 * insert arbitrated on `id` only. Postgres applies `ON CONFLICT` to the named
 * arbiter and to nothing else, so a row that cleared the primary key and then
 * collided on the sequence index raised a bare 23505 — surfacing to the
 * caller as a 500 with a Postgres string in it, and to CI as an intermittent
 * CX-8 failure that a re-run makes disappear.
 *
 * ── Why this is not just a wider ON CONFLICT ─────────────────────────────
 *
 * Widening to `ON CONFLICT DO NOTHING` would make the symptom vanish, and
 * that is exactly why it is wrong. The two ways to reach this collision want
 * OPPOSITE handling:
 *
 *   · REDELIVERY — the same match settled twice (JetStream redelivery, a
 *     retried submission, an operator replaying a day). `fillLegIdFor` is
 *     derived from `(market, sequence, role)`, so the same match always
 *     computes the same id and the same row. Nothing to do: the row is
 *     already correct and the ledger post below is idempotent on
 *     `trade.fill:<fillId>`. Absorb it silently.
 *
 *   · SEQUENCE REUSE — a DIFFERENT match claimed a `(market, sequence)` that
 *     is already spoken for. `OrderBook.sequence` is an in-memory counter
 *     that starts at 0 and is rebuilt by journal replay, so a book restored
 *     without its journal while `trade.fills` still holds the old rows hands
 *     the same sequence to a new trade. That is not a duplicate — it is the
 *     ledger's `trade.fill:<fillId>` key aliasing two different trades onto
 *     one transaction, and the second one silently never settling.
 *
 * Swallowing the second case is worse than the 500 it replaces: a 500 is at
 * least visible. So the row is read back and compared, and only a byte-equal
 * match is treated as a redelivery.
 *
 * The comparison is on the money-bearing columns — price, qty, quote amount,
 * fee — plus both order ids and the owner. `ts`/`created_at` are excluded:
 * they differ between the original write and a replay by construction, and
 * comparing them would turn every legitimate redelivery into an incident.
 */
export async function insertFillLeg(
  svc: Pick<TradeServiceInternal, 'sql'>,
  leg: {
    id: string;
    orderId: string;
    counterOrderId: string;
    marketId: string;
    symbol: string;
    userId: string;
    side: 'buy' | 'sell';
    role: 'maker' | 'taker';
    price: bigint;
    qty: bigint;
    quoteAmount: bigint;
    feeAsset: string;
    feeAmount: bigint;
    feeBps: number;
    /** A maker leg's rebate, or null. */
    rebate?: { readonly bps: number; readonly amount: bigint; readonly asset: string } | null;
    /** Why a leg whose order chose the token paid in the asset it received (fee-ifc.ts), or null. */
    feeFallback?: string | null;
    sequence: number;
    attribution: AuthAttribution;
  },
): Promise<void> {
  const rebate = leg.rebate ?? null;
  const attribution = requireAuthAttribution(leg.attribution);
  let inserted: Array<{ id: string }>;
  try {
    inserted = await svc.sql<Array<{ id: string }>>`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence,
        session_id, api_key_id, rebate_bps, rebate_amount, rebate_asset, fee_fallback
      ) VALUES (
        ${leg.id}, ${leg.orderId}, ${leg.counterOrderId},
        ${leg.marketId}, ${leg.userId}, ${leg.side}, ${leg.role},
        ${formatAmount(leg.price)}::numeric, ${formatAmount(leg.qty)}::numeric, ${formatAmount(leg.quoteAmount)}::numeric,
        ${leg.feeAsset}, ${formatAmount(leg.feeAmount)}::numeric, ${leg.feeBps}, ${leg.sequence},
        ${attribution.sessionId}, ${attribution.apiKeyId},
        ${rebate?.bps ?? null}, ${rebate ? formatAmount(rebate.amount) : null}::numeric, ${rebate?.asset ?? null},
        ${leg.feeFallback ?? null}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
  } catch (err) {
    /**
     * `ON CONFLICT (id)` names ONE arbiter, and Postgres applies the DO
     * NOTHING to that index alone. A row that clears `fills_pkey` and then
     * collides on `fills_market_sequence_role_idx` therefore RAISES rather
     * than returning zero rows — which is the whole bug: it left the caller
     * with a 500 carrying a Postgres string.
     *
     * Catching only 23505 (unique_violation). Anything else — a foreign key
     * to a deleted order, a CHECK on a negative amount — is a different
     * failure and must not be quietly re-interpreted as an idempotency
     * question.
     */
    if ((err as { code?: string })?.code !== '23505') throw err;
    inserted = [];
  }

  // Inserted, or the id already held this exact row. Either way we are done —
  // the id IS the business key, so an id collision cannot be a different fill.
  if (inserted.length > 0) return;

  /**
   * Nothing inserted. Two sub-cases, and only one of them is benign.
   *
   * The id conflict path is the ordinary redelivery and needs no read: the id
   * is derived from the same three columns the sequence index covers, so a
   * row holding this id necessarily holds this `(market, sequence, role)`.
   * Read it back anyway — cheaply, once, off the happy path — because the
   * whole point of this method is to stop assuming which conflict fired.
   */
  const [existing] = await svc.sql<Array<FillRow>>`
    SELECT * FROM trade.fills
    WHERE market_id = ${leg.marketId} AND sequence = ${leg.sequence} AND liquidity = ${leg.role}
    LIMIT 1
  `;

  if (!existing) {
    // The insert did nothing and no row is there. A concurrent transaction
    // holds it uncommitted, or something outside this service deleted it.
    // Either way this settle has not happened and must not report success.
    throw new TradeError(
      `fill ${leg.sequence} on ${leg.symbol} (${leg.role}) neither inserted nor found — a concurrent writer holds it uncommitted`,
      'trade.fill_sequence_conflict',
    );
  }

  const same =
    existing.id === leg.id &&
    existing.order_id === leg.orderId &&
    existing.counter_order_id === leg.counterOrderId &&
    existing.user_id === leg.userId &&
    parseAmount(existing.price) === leg.price &&
    parseAmount(existing.qty) === leg.qty &&
    parseAmount(existing.quote_amount) === leg.quoteAmount &&
    parseAmount(existing.fee_amount) === leg.feeAmount &&
    existing.fee_asset === leg.feeAsset &&
    (existing.fee_fallback ?? null) === (leg.feeFallback ?? null) &&
    (existing.session_id ?? null) === attribution.sessionId &&
    (existing.api_key_id ?? null) === attribution.apiKeyId;
  const sameRebate =
    (existing.rebate_bps === null || existing.rebate_bps === undefined ? null : Number(existing.rebate_bps)) === (rebate?.bps ?? null) &&
    (existing.rebate_amount ? parseAmount(existing.rebate_amount) : null) === (rebate?.amount ?? null) &&
    (existing.rebate_asset ?? null) === (rebate?.asset ?? null);

  // The ordinary case: this match already settled. The ledger post that
  // follows is keyed on `trade.fill:<fillId>` and returns the original
  // transaction, so continuing is a no-op rather than a second movement.
  if (same && sameRebate) return;
  // The same match, but the rebate the placement versions give now is not the one stored: a fee schedule version
  // under a placed order changed. The stored rebate stands; settling with another would be refused by the ledger.
  if (same) {
    throw new TradeError(
      `fill sequence ${leg.sequence} on ${leg.symbol} (${leg.role}) is stored with another maker rebate than its ` +
        `placement's fee schedule versions now give (stored ${existing.rebate_bps ?? 'none'} bps, now ${rebate?.bps ?? 'none'} bps). ` +
        `A stored fee schedule version changed after this order was placed.`,
      'trade.fill_sequence_conflict',
    );
  }

  /**
   * A DIFFERENT trade already owns this sequence.
   *
   * Refusing is the only safe answer. Writing under a new id would leave the
   * ledger key `trade.fill:<market>:<sequence>` pointing at whichever trade
   * settled first, and the second trade's money would never move while its
   * fill row claimed it had. The order fails, the hold stays intact, and the
   * name says what to investigate.
   */
  throw new TradeError(
    `fill sequence ${leg.sequence} on ${leg.symbol} (${leg.role}) is already held by a DIFFERENT match ` +
      `(stored fill ${existing.id} for order ${existing.order_id}; this match is ${leg.id} for order ${leg.orderId}). ` +
      `The engine's sequence counter has been reused — a book was almost certainly restored without its journal. ` +
      `Settling would alias two trades onto one ledger idempotency key.`,
    'trade.fill_sequence_conflict',
  );
}

export async function settleFill(svc: PublishingService, market: Market, fill: EngineFill): Promise<void> {
  // Before trade.fills and before any ledger post. The paper hold is zero
  // and unfunded; a recorded match makes a later finalize throw
  // trade.hold_uncovered. Do not fund the hold to make the post succeed.
  if (market.paper) {
    throw new TradeError(
      `${market.symbol} is paper — refusing the fill before trade.fills and before any ledger post`,
      'trade.paper_fill_refused',
    );
  }

  const qty = parseAmount(fill.qty);
  const price = parseAmount(fill.price);

  /**
   * FLOORED, and it has to be. The buy side was funded at `ceil(price x qty)`
   * for the whole order; a sum of floored parts can never exceed the ceiling
   * of the whole, so a partially filled order can never consume more hold
   * than it was given. Ceiling the parts could, by one wei per fill, and one
   * wei short at settlement is a fill the ledger refuses to post.
   */
  const quoteAmount = mul(price, qty, 'floor');
  if (quoteAmount <= 0n) {
    // The market's tick x lot grid is supposed to make this unreachable, and
    // the database has a CHECK saying so. If it happens anyway the listing is
    // wrong, and settling it is impossible — the ledger will not post a
    // movement of nothing.
    throw new TradeError(
      `fill ${fill.sequence} on ${market.symbol} has a zero quote amount — check the market's tick and lot sizes`,
      'trade.dust_fill',
    );
  }

  // An OCO leg (`<id>:tp` / `<id>:sl`) draws on its parent's one hold: settle against the parent row.
  fill = { ...fill, makerOrderId: settlementOrderId(fill.makerOrderId), takerOrderId: settlementOrderId(fill.takerOrderId) };

  const maker = await svc.findOrder(fill.makerOrderId);
  const taker = await svc.findOrder(fill.takerOrderId);
  const makerIsHouseMm = isHouseMmAccount(fill.makerAccountId);

  // House MM seed orders are not in trade.orders (seedMarket holds + matching
  // only). User taker must still exist. MM-as-taker is residual.
  if (!taker) {
    throw new TradeError(
      `fill ${fill.sequence} references an order this service does not know (${fill.makerOrderId} / ${fill.takerOrderId})`,
      'trade.order_not_found',
    );
  }
  // ── Token buyback taker path (J-dex-protocol-17) ────────────────────────
  // Routed by the order row's identity, before the house MM path: a buyback that crossed a house MM ask must be
  // refused, never settled as a customer taker against the MM pots.
  if (isBuybackUser(taker.userId) || (maker != null && isBuybackUser(maker.userId))) {
    await settleBuybackFill(svc, market, fill, { qty, price, quoteAmount, taker, maker, makerIsHouseMm });
    return;
  }
  if (!maker && !makerIsHouseMm) {
    throw new TradeError(
      `fill ${fill.sequence} references an order this service does not know (${fill.makerOrderId} / ${fill.takerOrderId})`,
      'trade.order_not_found',
    );
  }

  // ── House MM maker path (trade.mm-bot) ──────────────────────────────────
  // Route by identity, not "order row missing". A prior partial fill inserts a
  // stub trade.orders row; the next match must still use marketMakerMakerFill
  // (MM pot holds), never user tradeFill against HOUSE_MM_USER_UUID.
  const makerIsHouseMmRow = maker != null && maker.userId === HOUSE_MM_USER_UUID;
  if (makerIsHouseMm || makerIsHouseMmRow) {
    // The house maker has no tier of its own: it is charged the regular row; the taker its own placement tier.
    const rates = await svc.ratesForFill(
      0,
      taker.feeDiscountBps,
      market.kind,
      market.symbol,
      { maker: taker.createdAt, taker: taker.createdAt },
      { maker: REGULAR_FEE_TIER, taker: taker.feeTier },
    );
    const takerBuys = fill.takerSide === 'buy';
    // BEFORE any fill row: fee-equal-to-receivable is permanently unpostable
    // (recipe throws; re-run throws). Inserting first left remainingHold
    // overstated forever — README recovery claim was false for this class.
    svc.assertFillFeesPostable(fill.sequence, market.symbol, fill.takerSide, qty, quoteAmount, rates);
    const takerFeeInReceived = mulBps(takerBuys ? qty : quoteAmount, rates.takerFeeBps);
    const makerFee = mulBps(takerBuys ? quoteAmount : qty, rates.makerFeeBps);
    const makerSide = takerBuys ? ('sell' as const) : ('buy' as const);
    const makerFeeAsset = takerBuys ? market.quoteAsset : market.baseAsset;
    const takerReceives = takerBuys ? market.baseAsset : market.quoteAsset;
    // fills.order_id FK → trade.orders. Seed path never wrote a row; insert a
    // bookkeeping stub. Hold value lives on MM ledger pots; row hold_amount
    // is the fill notional (orders_hold_positive_ck) for this match only.
    // seeded=true so public tape / candles exclude house MM prints (SD-3).
    const makerHoldAsset = takerBuys ? market.baseAsset : market.quoteAsset;
    const makerHoldAmount = takerBuys ? qty : quoteAmount;
    const mmAttribution = houseMmAttribution();
    const takerAttribution = attributionFromOrder(taker);
    await svc.sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, price, qty, status, tif,
        hold_asset, hold_amount, fee_discount_bps, seeded, session_id, api_key_id
      ) VALUES (
        ${fill.makerOrderId}, ${HOUSE_MM_USER_UUID}, ${market.id}, ${makerSide}, ${'limit'},
        ${formatAmount(price)}::numeric, ${formatAmount(qty)}::numeric, ${'open'}, ${'PO'},
        ${makerHoldAsset}, ${formatAmount(makerHoldAmount)}::numeric, ${0}, ${true},
        ${mmAttribution.sessionId}, ${mmAttribution.apiKeyId}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // Same guard as the classic path below: a sequence already owned by a
    // different match must refuse, not silently no-op. The MM pot is still
    // real money.
    await svc.insertFillLeg({
      id: fillLegIdFor(market.id, fill.sequence, 'maker'),
      orderId: fill.makerOrderId,
      counterOrderId: taker.id,
      marketId: market.id,
      symbol: market.symbol,
      userId: HOUSE_MM_USER_UUID,
      side: makerSide,
      role: 'maker',
      price,
      qty,
      quoteAmount,
      feeAsset: makerFeeAsset,
      feeAmount: makerFee,
      feeBps: rates.makerFeeBps,
      sequence: fill.sequence,
      attribution: mmAttribution,
    });
    const takerRow = (ifc: IfcLegDecision) => ({
      id: fillLegIdFor(market.id, fill.sequence, 'taker'),
      orderId: taker.id,
      counterOrderId: fill.makerOrderId,
      marketId: market.id,
      symbol: market.symbol,
      userId: taker.userId,
      side: fill.takerSide,
      role: 'taker' as const,
      price,
      qty,
      quoteAmount,
      feeAsset: ifc.charged?.tokenAsset ?? takerReceives,
      feeAmount: ifc.charged?.net ?? takerFeeInReceived,
      feeBps: rates.takerFeeBps,
      feeFallback: ifc.fallback,
      sequence: fill.sequence,
      attribution: takerAttribution,
    });
    // A taker paying in the token is charged it before its row; the fill then takes no fee from what it receives.
    let takerWritten = false;
    const takerIfc = await settleIfcLeg(
      ifcDeps(svc, takerAttribution),
      {
        legId: fillLegIdFor(market.id, fill.sequence, 'taker'),
        marketId: market.id,
        sequence: fill.sequence,
        role: 'taker',
        order: taker,
        feeAsset: takerReceives,
        fee: takerFeeInReceived,
        rebateFill: false,
      },
      async (ifc, sql) => {
        await insertFillLeg({ sql }, takerRow(ifc));
        takerWritten = true;
      },
    );
    const takerFee = takerIfc.charged?.net ?? takerFeeInReceived;
    const takerFeeAsset = takerIfc.charged?.tokenAsset ?? takerReceives;
    const takerFillFeeBps = takerIfc.charged ? 0 : rates.takerFeeBps;
    if (!takerWritten) await svc.insertFillLeg(takerRow(takerIfc));

    await svc.refreshFilledQty(taker.id);
    await svc.notePartialIfOpen(taker.id, formatAmount(qty), formatAmount(price), `fill:${fill.sequence}:taker`);

    await svc.ledger.post(
      withFillLedgerAttribution(
        recipes.marketMakerMakerFill({
          fillId: fillIdFor(market.id, fill.sequence),
          takerId: taker.userId,
          makerOrderId: fill.makerOrderId,
          takerOrderId: taker.id,
          baseAsset: market.baseAsset,
          quoteAsset: market.quoteAsset,
          qty,
          quoteAmount,
          takerSide: fill.takerSide,
          makerFeeBps: rates.makerFeeBps,
          takerFeeBps: takerFillFeeBps,
        }),
        mmAttribution,
        takerAttribution,
      ),
    );

    await svc.notifyAffiliateAccrue({
      fillId: fillIdFor(market.id, fill.sequence),
      makerUserId: HOUSE_MM_USER_UUID,
      takerUserId: taker.userId,
      makerFee,
      takerFee,
      makerFeeAsset,
      takerFeeAsset,
    });
    await svc.notifyAffiliatePayout({
      fillId: fillIdFor(market.id, fill.sequence),
      makerUserId: HOUSE_MM_USER_UUID,
      takerUserId: taker.userId,
      makerFee,
      takerFee,
      makerFeeAsset,
      takerFeeAsset,
    });
    await svc.notifyCopyMirrorFill({
      orderId: taker.id,
      fillId: fillLegIdFor(market.id, fill.sequence, 'taker'),
      side: fill.takerSide,
      price,
      qty,
    });

    const takerSettledAt = new Date().toISOString();
    await svc.bus.publish(
      'fillSettled',
      {
        fillId: fillLegIdFor(market.id, fill.sequence, 'taker'),
        orderId: taker.id,
        userId: taker.userId,
        marketId: market.id,
        side: fill.takerSide,
        liquidity: 'taker',
        price: formatAmount(price),
        qty: formatAmount(qty),
        quoteAmount: formatAmount(quoteAmount),
        feeAsset: takerFeeAsset,
        feeAmount: formatAmount(takerFee),
        feeBps: rates.takerFeeBps,
        sequence: fill.sequence,
        ts: takerSettledAt,
      },
      { idempotencyKey: `trade.fill.settled:${market.id}:${fill.sequence}:taker` },
    );
    await svc.notifyDropCopyFill({
      fillId: fillLegIdFor(market.id, fill.sequence, 'taker'),
      orderId: taker.id,
      userId: taker.userId,
      marketId: market.id,
      side: fill.takerSide,
      price: formatAmount(price),
      qty: formatAmount(qty),
      quoteAmount: formatAmount(quoteAmount),
      feeAsset: takerFeeAsset,
      feeAmount: formatAmount(takerFee),
      sequence: fill.sequence,
      ts: takerSettledAt,
      order: taker,
    });
    const latest = await svc.findOrder(taker.id);
    if (latest) await svc.publishOrderUpdated(latest);
    return;
  }

  // Both user orders — classic path.
  if (!maker) {
    throw new TradeError(
      `fill ${fill.sequence} references an order this service does not know (${fill.makerOrderId} / ${fill.takerOrderId})`,
      'trade.order_not_found',
    );
  }

  // Both rates in one place: `tradeFill` posts them in one six-entry
  // transaction, and resolving them apart would let one side's rounding drift
  // from the other's without anything failing.
  const rates = await svc.ratesForFill(
    maker.feeDiscountBps,
    taker.feeDiscountBps,
    market.kind,
    market.symbol,
    { maker: maker.createdAt, taker: taker.createdAt },
    { maker: maker.feeTier, taker: taker.feeTier },
  );

  const takerBuys = fill.takerSide === 'buy';
  // BEFORE fill rows: same fee-exhaust guard as the MM path above. Recipe
  // layer already refuses; without this the fills table permanently outruns
  // the ledger and release understates remainder.
  svc.assertFillFeesPostable(fill.sequence, market.symbol, fill.takerSide, qty, quoteAmount, rates);
  // Each side's fee comes out of what that side RECEIVES (see `tradeFill`), unless its order pays in the token.
  const takerFee = mulBps(takerBuys ? qty : quoteAmount, rates.takerFeeBps);
  const makerFee = mulBps(takerBuys ? quoteAmount : qty, rates.makerFeeBps);

  // The one input both ledger posts take, so the rebate cannot drift from the fill it rebates. These are the rates in
  // the received assets; a side charged in the token posts 0 below.
  const ratedFillInput = {
    fillId: fillIdFor(market.id, fill.sequence),
    makerId: maker.userId,
    takerId: taker.userId,
    // P0-3: name whose reservation each side is spending. These come from
    // the order store — this service's source of truth for a fill (see the
    // P0-2 ADR) — not from the engine event, which carries neither.
    makerOrderId: maker.id,
    takerOrderId: taker.id,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    qty,
    quoteAmount,
    takerSide: fill.takerSide,
    makerFeeBps: rates.makerFeeBps,
    takerFeeBps: rates.takerFeeBps,
  };
  // A maker rebate (SP-fees-vip-01) is paid in what the maker paid, out of this fill's taker fee, and never as a
  // negative fee. Deterministic from the two placement versions, so a redelivery computes the same one.
  const rebate =
    rates.makerRebateBps > 0
      ? { bps: rates.makerRebateBps, ...makerRebateFor({ ...ratedFillInput, makerRebateBps: rates.makerRebateBps }) }
      : null;
  const paidRebate = rebate && rebate.amount > 0n ? { bps: rebate.bps, amount: rebate.amount, asset: rebate.assetId } : null;

  const legs = [
    {
      role: 'maker' as const,
      order: maker,
      counterOrderId: taker.id,
      side: takerBuys ? ('sell' as const) : ('buy' as const),
      feeAsset: takerBuys ? market.quoteAsset : market.baseAsset,
      feeAmount: makerFee,
      feeBps: rates.makerFeeBps,
      rebate: paidRebate,
    },
    {
      role: 'taker' as const,
      order: taker,
      counterOrderId: maker.id,
      side: fill.takerSide,
      feeAsset: takerBuys ? market.baseAsset : market.quoteAsset,
      feeAmount: takerFee,
      feeBps: rates.takerFeeBps,
      rebate: null,
    },
  ];

  // Conflict on deterministic fill id (market+seq+role). Concurrent inline
  // settle + NATS redelivery must not 500 on fills_pkey — that broke CX-8 L3.
  const makerAttribution = attributionFromOrder(maker);
  const takerAttribution = attributionFromOrder(taker);
  const rowOf = (leg: (typeof legs)[number], ifc: IfcLegDecision) => ({
    id: fillLegIdFor(market.id, fill.sequence, leg.role),
    orderId: leg.order.id,
    counterOrderId: leg.counterOrderId,
    marketId: market.id,
    symbol: market.symbol,
    userId: leg.order.userId,
    side: leg.side,
    role: leg.role,
    price,
    qty,
    quoteAmount,
    feeAsset: ifc.charged?.tokenAsset ?? leg.feeAsset,
    feeAmount: ifc.charged?.net ?? leg.feeAmount,
    feeBps: leg.feeBps,
    feeFallback: ifc.fallback,
    rebate: leg.rebate,
    sequence: fill.sequence,
    attribution: leg.role === 'maker' ? makerAttribution : takerAttribution,
  });

  // ── 4b · A FEE PAID IN THE TOKEN ──────────────────────────────────────────
  //
  // Before the fill rows and `tradeFill` (fee-ifc.ts): a leg whose order chose the token is charged it and written, or
  // written with why it stays in the received asset. A taker whose fee pays this fill's maker rebate keeps it there.
  const decided: IfcLegDecision[] = [];
  const written = new Set<'maker' | 'taker'>();
  for (const leg of legs) {
    decided.push(
      await settleIfcLeg(
        ifcDeps(svc, leg.role === 'maker' ? makerAttribution : takerAttribution),
        {
          legId: fillLegIdFor(market.id, fill.sequence, leg.role),
          marketId: market.id,
          sequence: fill.sequence,
          role: leg.role,
          order: leg.order,
          feeAsset: leg.feeAsset,
          fee: leg.feeAmount,
          rebateFill: leg.role === 'taker' && paidRebate !== null,
        },
        async (ifc, sql) => {
          await insertFillLeg({ sql }, rowOf(leg, ifc));
          written.add(leg.role);
        },
      ),
    );
  }
  const [makerIfc, takerIfc] = decided as [IfcLegDecision, IfcLegDecision];
  const fillInput = {
    ...ratedFillInput,
    makerFeeBps: makerIfc.charged ? 0 : ratedFillInput.makerFeeBps,
    takerFeeBps: takerIfc.charged ? 0 : ratedFillInput.takerFeeBps,
  };
  // A rebate is paid out of the taker fee in the received asset, so a rebate fill never charges its taker the token
  // (and its maker owes no fee to charge). Settling one that did would post a rebate the fill never funded.
  if (paidRebate && (makerIfc.charged || takerIfc.charged)) {
    throw new TradeError(
      `fill ${fill.sequence} on ${market.symbol} pays a maker rebate and a fee in the token; refusing before the fill post`,
      'trade.rebate_recipe_unavailable',
    );
  }

  // A leg decided and written under its lock above is not written again.
  for (const [i, leg] of legs.entries()) {
    if (!written.has(leg.role)) await svc.insertFillLeg(rowOf(leg, decided[i]!));
  }

  // Recomputed from the fills rather than incremented, so it is idempotent by
  // construction and `filled_qty = Σ fills.qty` is true by definition rather
  // than by hope. A test asserts it anyway.
  for (const leg of legs) {
    await svc.refreshFilledQty(leg.order.id);
    await svc.notePartialIfOpen(leg.order.id, formatAmount(qty), formatAmount(price), `fill:${fill.sequence}:${leg.role}`);
  }

  // ── 5 · THE FILL ────────────────────────────────────────────────────────
  //
  // The six-entry atomic fill. Both sides' holds are drawn down and both
  // sides' fees land in `houseFees('trade', …)` in one transaction, so there
  // is no interleaving in which one side has paid and the other has not.
  await svc.ledger.post(withFillLedgerAttribution(recipes.tradeFill(fillInput), makerAttribution, takerAttribution));

  // ── 5b · THE MAKER REBATE ───────────────────────────────────────────────
  //
  // Its own post, right after the fill whose taker fee pays it; the ledger checks it against that posted fill. A crash
  // between the two leaves the rebate unpaid and nothing held: a redelivery re-runs this method, the fill key returns
  // the first post and this key pays the rebate once.
  if (paidRebate) {
    await svc.ledger.post(
      withLedgerAttribution(recipes.tradeFillMakerRebate({ ...fillInput, makerRebateBps: paidRebate.bps }), makerAttribution),
    );
  }

  // Affiliates share what the house kept: a rebate is paid out of the taker's fee, in that fee's own asset.
  // A fee paid in the token is shared in the token, as it landed in the house fees.
  const affiliateFees = {
    fillId: fillIdFor(market.id, fill.sequence),
    makerUserId: maker.userId,
    takerUserId: taker.userId,
    makerFee: makerIfc.charged?.net ?? makerFee,
    takerFee: takerIfc.charged?.net ?? (paidRebate ? takerFee - paidRebate.amount : takerFee),
    makerFeeAsset: makerIfc.charged?.tokenAsset ?? (takerBuys ? market.quoteAsset : market.baseAsset),
    takerFeeAsset: takerIfc.charged?.tokenAsset ?? (takerBuys ? market.baseAsset : market.quoteAsset),
  };
  await svc.notifyAffiliateAccrue(affiliateFees);
  await svc.notifyAffiliatePayout(affiliateFees);

  // User-visible fill + order snapshots for private WS (not money — ledger already moved).
  for (const [i, leg] of legs.entries()) {
    const paid = rowOf(leg, decided[i]!);
    const settledAt = new Date().toISOString();
    await svc.bus.publish(
      'fillSettled',
      {
        fillId: fillLegIdFor(market.id, fill.sequence, leg.role),
        orderId: leg.order.id,
        userId: leg.order.userId,
        marketId: market.id,
        side: leg.side,
        liquidity: leg.role,
        price: formatAmount(price),
        qty: formatAmount(qty),
        quoteAmount: formatAmount(quoteAmount),
        feeAsset: paid.feeAsset,
        feeAmount: formatAmount(paid.feeAmount),
        feeBps: leg.feeBps,
        sequence: fill.sequence,
        ts: settledAt,
      },
      { idempotencyKey: `trade.fill.settled:${market.id}:${fill.sequence}:${leg.role}` },
    );
    await svc.notifyDropCopyFill({
      fillId: fillLegIdFor(market.id, fill.sequence, leg.role),
      orderId: leg.order.id,
      userId: leg.order.userId,
      marketId: market.id,
      side: leg.side,
      price: formatAmount(price),
      qty: formatAmount(qty),
      quoteAmount: formatAmount(quoteAmount),
      feeAsset: paid.feeAsset,
      feeAmount: formatAmount(paid.feeAmount),
      sequence: fill.sequence,
      ts: settledAt,
      order: leg.order,
    });
    await svc.notifyCopyMirrorFill({
      orderId: leg.order.id,
      fillId: fillLegIdFor(market.id, fill.sequence, leg.role),
      side: leg.side,
      price,
      qty,
    });
    const latest = await svc.findOrder(leg.order.id);
    if (latest) await svc.publishOrderUpdated(latest);
  }
}

/** What a token fee charge runs on: the ledger posting as the leg's own order, and the order's schedule version. */
function ifcDeps(svc: TradeServiceInternal, attribution: AuthAttribution) {
  return {
    sql: svc.sql,
    ledger: {
      post: (req: PostRequest) => svc.ledger.post(withLedgerAttribution(req, attribution)),
      getTxByKey: (key: string) => svc.ledger.getTxByKey(key),
    },
    termsAt: async (at: Date) => {
      const schedule = await svc.feeScheduleAt(at);
      return schedule.published === true ? (schedule.ifcFee ?? null) : null;
    },
  };
}

/**
 * After house fees posted. Identity accrue is best-effort (412 / down / timeout
 * must not unwind the fill). Never invents commission rates.
 */
export async function notifyAffiliateAccrue(
  svc: TradeServiceInternal,
  input: {
    fillId: string;
    makerUserId: string;
    takerUserId: string;
    makerFee: Amount;
    takerFee: Amount;
    makerFeeAsset: string;
    takerFeeAsset: string;
  },
): Promise<void> {
  await fireAffiliateAccrue(svc.affiliateAccrue, affiliateLegsAfterFill({ ...input, houseMmUserId: HOUSE_MM_USER_UUID }));
}

export async function notifyCopyMirrorFill(
  svc: TradeServiceInternal,
  notice: {
    orderId: string;
    fillId: string;
    side: 'buy' | 'sell';
    price: Amount;
    qty: Amount;
  },
): Promise<void> {
  if (!svc.onCopyMirrorFill) return;
  try {
    await svc.onCopyMirrorFill(notice);
  } catch (err) {
    console.warn(
      `svc-trade: copy mirror fill event failed orderId=${notice.orderId} — fill already settled`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * After ledger settle. Drop-copy is evidence — ingest failure must not unwind money.
 * Source is explicit (rfq) or proveable from the order (rest). Session-only omits.
 */
export async function notifyDropCopyFill(
  svc: TradeServiceInternal,
  input: Omit<DropCopyFillWire, 'source'> & {
    readonly source?: DropCopyHitchSource;
    readonly order?: { readonly apiKeyId?: string | null };
  },
): Promise<void> {
  const source = input.source ?? (input.order !== undefined ? dropCopySourceForBookOrder(input.order) : null);
  if (source === null) return;
  await fireDropCopyFill(svc.dropCopyIngest, {
    fillId: input.fillId,
    orderId: input.orderId,
    userId: input.userId,
    marketId: input.marketId,
    side: input.side,
    price: input.price,
    qty: input.qty,
    quoteAmount: input.quoteAmount,
    feeAsset: input.feeAsset,
    feeAmount: input.feeAmount,
    sequence: input.sequence,
    ts: input.ts,
    source,
  });
}

/** Best-effort payout after accrue; never throws. Fill already committed. */
export async function notifyAffiliatePayout(
  svc: TradeServiceInternal,
  input: {
    fillId: string;
    makerUserId: string;
    takerUserId: string;
    makerFee: Amount;
    takerFee: Amount;
    makerFeeAsset: string;
    takerFeeAsset: string;
  },
): Promise<void> {
  await fireAffiliatePayout(svc.affiliatePayout, affiliateLegsAfterFill({ ...input, houseMmUserId: HOUSE_MM_USER_UUID }));
}

/**
 * One fill of the token buyback's IOC buy against a resting customer ask (`buyback-order.ts`).
 *
 * Refused before any row or post: a house market-maker maker (house against house is wash volume), a buyback order on
 * the maker side (an IOC never rests), and a buyback that sells. The customer maker is charged its own maker rate at
 * its own tier, in what it receives or in the token as it chose; the house takes no taker fee from itself and the
 * fill carries no maker rebate (a rebate is paid out of a taker fee, and this taker pays none).
 *
 * Same ordering as the classic path: both fill rows, then `buybackTakerFill`, keyed on the engine's (market, sequence).
 */
export async function settleBuybackFill(
  svc: PublishingService,
  market: Market,
  fill: EngineFill,
  parts: {
    qty: Amount;
    price: Amount;
    quoteAmount: Amount;
    taker: OrderRecord;
    maker: OrderRecord | null;
    makerIsHouseMm: boolean;
  },
): Promise<void> {
  const { qty, price, quoteAmount, taker, maker } = parts;
  if (parts.makerIsHouseMm || maker?.userId === HOUSE_MM_USER_UUID || (maker != null && isBuybackUser(maker.userId))) {
    throw new TradeError(
      `fill ${fill.sequence} on ${market.symbol} matches the token buyback against a house order; house against house is refused before any row or post`,
      BUYBACK_HOUSE_MAKER,
    );
  }
  if (!isBuybackUser(taker.userId) || fill.takerSide !== 'buy' || taker.side !== 'buy') {
    throw new TradeError(`fill ${fill.sequence} on ${market.symbol}: the token buyback only ever takes a buy`, BUYBACK_INVALID);
  }
  if (!maker) {
    throw new TradeError(
      `fill ${fill.sequence} references an order this service does not know (${fill.makerOrderId} / ${fill.takerOrderId})`,
      'trade.order_not_found',
    );
  }

  const placed = await svc.ratesForFill(
    maker.feeDiscountBps,
    0,
    market.kind,
    market.symbol,
    { maker: maker.createdAt, taker: maker.createdAt },
    { maker: maker.feeTier, taker: REGULAR_FEE_TIER },
  );
  const rates = { makerFeeBps: placed.makerFeeBps, takerFeeBps: 0 };
  svc.assertFillFeesPostable(fill.sequence, market.symbol, 'buy', qty, quoteAmount, rates);
  const makerFee = mulBps(quoteAmount, rates.makerFeeBps);

  const makerAttribution = attributionFromOrder(maker);
  const houseAttribution = buybackAttribution();
  const makerRow = (ifc: IfcLegDecision) => ({
    id: fillLegIdFor(market.id, fill.sequence, 'maker'),
    orderId: maker.id,
    counterOrderId: taker.id,
    marketId: market.id,
    symbol: market.symbol,
    userId: maker.userId,
    side: 'sell' as const,
    role: 'maker' as const,
    price,
    qty,
    quoteAmount,
    feeAsset: ifc.charged?.tokenAsset ?? market.quoteAsset,
    feeAmount: ifc.charged?.net ?? makerFee,
    feeBps: rates.makerFeeBps,
    feeFallback: ifc.fallback,
    rebate: null,
    sequence: fill.sequence,
    attribution: makerAttribution,
  });

  // A maker paying its fee in the token is charged it before its row (fee-ifc.ts); the fill then takes no maker fee.
  let makerWritten = false;
  const makerIfc = await settleIfcLeg(
    ifcDeps(svc, makerAttribution),
    {
      legId: fillLegIdFor(market.id, fill.sequence, 'maker'),
      marketId: market.id,
      sequence: fill.sequence,
      role: 'maker',
      order: maker,
      feeAsset: market.quoteAsset,
      fee: makerFee,
      rebateFill: false,
    },
    async (ifc, sql) => {
      await insertFillLeg({ sql }, makerRow(ifc));
      makerWritten = true;
    },
  );
  if (!makerWritten) await svc.insertFillLeg(makerRow(makerIfc));
  await svc.insertFillLeg({
    id: fillLegIdFor(market.id, fill.sequence, 'taker'),
    orderId: taker.id,
    counterOrderId: maker.id,
    marketId: market.id,
    symbol: market.symbol,
    userId: taker.userId,
    side: 'buy',
    role: 'taker',
    price,
    qty,
    quoteAmount,
    feeAsset: market.baseAsset,
    feeAmount: 0n,
    feeBps: 0,
    sequence: fill.sequence,
    attribution: houseAttribution,
  });

  for (const [order, role] of [
    [maker, 'maker'],
    [taker, 'taker'],
  ] as const) {
    await svc.refreshFilledQty(order.id);
    await svc.notePartialIfOpen(order.id, formatAmount(qty), formatAmount(price), `fill:${fill.sequence}:${role}`);
  }

  await svc.ledger.post(
    withFillLedgerAttribution(
      recipes.buybackTakerFill({
        fillId: fillIdFor(market.id, fill.sequence),
        makerId: maker.userId,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        qty,
        quoteAmount,
        makerFeeBps: makerIfc.charged ? 0 : rates.makerFeeBps,
      }),
      makerAttribution,
      houseAttribution,
    ),
  );

  const paid = makerRow(makerIfc);
  const affiliateFees = {
    fillId: fillIdFor(market.id, fill.sequence),
    makerUserId: maker.userId,
    takerUserId: taker.userId,
    makerFee: paid.feeAmount,
    takerFee: 0n,
    makerFeeAsset: paid.feeAsset,
    takerFeeAsset: market.baseAsset,
  };
  await svc.notifyAffiliateAccrue(affiliateFees);
  await svc.notifyAffiliatePayout(affiliateFees);

  await svc.notifyCopyMirrorFill({
    orderId: maker.id,
    fillId: paid.id,
    side: 'sell',
    price,
    qty,
  });

  // Only the customer's leg is a user-visible fill; the house leg has no customer to tell.
  const settledAt = new Date().toISOString();
  await svc.bus.publish(
    'fillSettled',
    {
      fillId: paid.id,
      orderId: maker.id,
      userId: maker.userId,
      marketId: market.id,
      side: 'sell',
      liquidity: 'maker',
      price: formatAmount(price),
      qty: formatAmount(qty),
      quoteAmount: formatAmount(quoteAmount),
      feeAsset: paid.feeAsset,
      feeAmount: formatAmount(paid.feeAmount),
      feeBps: rates.makerFeeBps,
      sequence: fill.sequence,
      ts: settledAt,
    },
    { idempotencyKey: `trade.fill.settled:${market.id}:${fill.sequence}:maker` },
  );
  await svc.notifyDropCopyFill({
    fillId: paid.id,
    orderId: maker.id,
    userId: maker.userId,
    marketId: market.id,
    side: 'sell',
    price: formatAmount(price),
    qty: formatAmount(qty),
    quoteAmount: formatAmount(quoteAmount),
    feeAsset: paid.feeAsset,
    feeAmount: formatAmount(paid.feeAmount),
    sequence: fill.sequence,
    ts: settledAt,
    order: maker,
  });
  const latest = await svc.findOrder(maker.id);
  if (latest) await svc.publishOrderUpdated(latest);
}
