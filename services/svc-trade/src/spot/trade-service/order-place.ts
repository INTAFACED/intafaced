/**
 * Placing an order: admission, the engine sequence check, executing an admitted order and paper orders.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { TradingControlError, canonicalPayload, type TradingOperationKind } from '../../controls/trading-controls.js';
import { businessPayload } from '../../controls/business-payload.js';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import { withMoneySpan } from '../../tracing.js';
import { orderIdFor } from '../ids.js';
import { REGULAR_FEE_TIER } from '../fee-schedule.js';
import { isPlacedForThem } from '../fee-tier-store.js';
import { ifcFeeAtPlacement, sameFeeCurrency, type IfcPlacement } from '../fee-ifc.js';
import {
  assertMarketOpen,
  assertNotional,
  assertPrice,
  assertQty,
  assertSettlementRails,
  assertTradable,
  holdFor,
  protectionPriceFor,
  sellProtectionPriceFor,
  requireSupportedType,
} from '../risk.js';
import { slippageToleranceFor } from '../slippage-tolerance.js';
import { assertOperatorRiskOnPlace } from '../../admin/risk.js';
import { classifyHoldPostError } from '../hold-outcome.js';
import { BUYBACK_INVALID, isBuybackUser } from '../buyback-order.js';
import { assertSubAccountOwned } from '../sub-account-ownership.js';
import { assertEmailProved } from '../email-proof.js';
import { type EngineSubmitRequest } from '../matching-client.js';
import { judgeEngineSequence, probeEngineSequence } from '../sequence-guard.js';
import { attributionFromPrincipal, withLedgerAttribution, type AuthAttribution } from '../auth-attribution.js';
import { type LifecycleAdmissionProof } from '../../lifecycle-proof.js';
import { TradeError, type Market, type OrderRecord, type OrderType, type TimeInForce } from '../types.js';
import type { PlaceOrderInput, TradeServiceInternal } from '../trade-service.js';
import { assertSamePlaceCommand } from './internal.js';

// ── The order flow (§5.2) ──────────────────────────────────────────────────
export async function placeOrder(svc: TradeServiceInternal, principal: Principal, input: PlaceOrderInput): Promise<OrderRecord> {
  return withMoneySpan(
    'trade.placeOrder',
    {
      operation: 'place_order',
      userId: principal.userId,
      symbol: input.symbol,
      side: input.side,
      qty: formatAmount(input.qty),
    },
    async (span) => {
      const order = await svc.placeOrderInner(principal, input);
      span.setAttribute('intafaced.order_id', order.id);
      span.setAttribute('intafaced.order_status', order.status);
      // User-visible lifecycle (private WS). The legacy event catalog cannot
      // represent RECOVERY_REQUIRED, so unresolved snapshots are exposed via
      // the REST/private projections below and are deliberately not emitted
      // as a misleading OPEN/REJECTED event.
      if (order.status !== 'recovery_required' && order.status !== 'hold_unknown') await svc.publishOrderUpdated(order);
      return order;
    },
  );
}

export async function placeOrderInner(
  svc: TradeServiceInternal,
  principal: Principal,
  input: PlaceOrderInput,
  kind: TradingOperationKind,
  parentBusinessId?: string,
): Promise<OrderRecord> {
  // ── 1 · AUTH + SCOPE ────────────────────────────────────────────────────
  // First, before anything is read and long before anything is held. The
  // tRPC router applies the same check as a `scopedProcedure`; it is repeated
  // here so that every caller of this service — router, event consumer,
  // future gRPC edge — passes through the same gate, rather than the gate
  // living in one transport.
  requireScope(principal, 'trade:write');
  const attribution = attributionFromPrincipal(principal);
  const userId = principal.userId;
  // The buyback's house user places only through its own door (`./buyback.ts`), never as a customer.
  if (isBuybackUser(userId)) {
    throw new TradeError('the token buyback places only through its service door', BUYBACK_INVALID);
  }

  // NO ORDERABLE PLANE AT ALL — refused before the registry is touched.
  //
  // This check used to be `if (!this.spotEnabled)`, and it runs BEFORE
  // `requireMarket` on purpose: an operator who has halted the venue should be
  // told the venue is halted, not sent on a symbol lookup that answers
  // `market_not_found` for a market that exists. Keeping it here preserves that
  // ordering exactly.
  //
  // With futures orderable there are two planes, so the pre-resolution refusal
  // can only fire when NEITHER can take an order; the per-kind answer needs the
  // market and comes straight after it is loaded. With `TRADE_FUTURES_ENABLED`
  // off — the shipped default — `!spotEnabled && !futuresEnabled` reduces to
  // `!spotEnabled` and this line behaves identically to the one it replaced.
  if (!svc.spotEnabled && !svc.futuresEnabled) {
    throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
  }

  const seeded = input.seeded === true;
  if (seeded && !svc.seedPlaceEnabled) {
    throw new TradeError('seed/mm place is disabled by the operator kill-switch', 'trade.seed_disabled');
  }

  // ── 2 · RISK CHECKS ─────────────────────────────────────────────────────
  const market = await svc.requireMarket(input);

  // Retry identity is resolved before mutable market/operator/dependency
  // checks. A retry must find the original even after a halt or outage; it
  // never creates new risk and cannot blind-resubmit an unresolved command.
  if (input.clientOrderId == null || input.clientOrderId.length < 1 || input.clientOrderId.length > 64) {
    throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
  }
  const orderType: OrderType = requireSupportedType(input.type);
  let tif: TimeInForce = input.seeded === true ? 'PO' : (input.tif ?? 'GTC');
  if (tif === 'MOC') {
    throw new TradeError('maker-or-cancel is not yet accepted by the trade service', 'trade.invalid_tif');
  }
  const expectedSeeded = market.paper ? false : seeded;
  const orderId = orderIdFor(userId, market.id, input.clientOrderId);
  const existing = await svc.findOrder(orderId);
  if (existing) {
    assertSamePlaceCommand(existing, input, orderType, tif, expectedSeeded);
    assertSameFeeCurrency(existing, input, market);
    // A lost hold reply left this row. The same key resolves it; it does not
    // open a second hold and it does not return the stuck row as placed.
    if (existing.status === 'hold_unknown') return svc.resumeHoldUnknown(existing, 'retry');
    return existing;
  }
  const businessId = `order:${orderId}`;
  const request = businessPayload({ ...input, symbol: market.symbol, marketId: market.id, type: orderType, tif });
  const original = await svc.accountAdmission?.original(userId, businessId);
  // An admitted original was granted only after the email-proof gate below passed.
  // The decision was made at admission, so finishing it needs no second read even
  // if the proof has lapsed since (an email change clears it).
  if (original) {
    const evidence = original.payload as Record<string, unknown>;
    if (canonicalPayload(evidence.request) !== canonicalPayload(request)) throw new TradingControlError('operation.conflict');
    await svc.admitAccountOperation(principal, kind, businessId, evidence, parentBusinessId, input.subAccountId);
    return svc.executeAdmittedOrder(evidence);
  }

  // Normalize the actual command before PX-S01. Seed/mm is forced post-only,
  // so its proof must say PLACE_POST_ONLY even when the caller omitted tif.
  // PX-S01 is the single state gate for both projections and new risk. It is
  // deliberately after idempotency lookup: a retry of an existing command
  // cannot create new value and remains recoverable during an authority
  // outage. A fresh PLACE/PLACE_POST_ONLY must have explicit authority,
  // dossier, session, risk, and matching readiness evidence.
  const lifecycleProof = await svc.assertLifecycleAction(market, tif === 'PO' ? 'PLACE_POST_ONLY' : 'PLACE', orderType);

  // The per-kind half of the kill-switch. `TRADE_SPOT_ENABLED` is the spot
  // plane's switch and stays exactly that — it does not halt futures, and
  // `TRADE_FUTURES_ENABLED` does not halt spot. Two planes, two switches; a
  // single boolean standing for both would make an operator stopping one stop
  // the other, and there is no version of that which is the honest answer.
  if (market.kind === 'spot' && !svc.spotEnabled) {
    throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
  }
  // SD-5 applies before the paper branch too: a seeded command is always a
  // priced maker command, and its proof has already been bound to PO above.
  if (seeded && orderType !== 'limit') {
    throw new TradeError('seed/mm orders must be limit post-only (liquidity provision only)', 'trade.seed_must_make');
  }
  if (tif === 'PO' && orderType !== 'limit') {
    throw new TradeError('post-only requires a limit price', 'trade.invalid_price');
  }
  assertTradable(market, {
    futuresEnabled: svc.futuresEnabled,
    optionsSettlementLawStamped: svc.optionsSettlementAssetLaw.trim().length > 0,
    now: svc.now(),
  });
  // W4 U1: seed FX/commodity stay active in DB; place must refuse before hold.
  assertSettlementRails(market);

  // Hours/schedule refuse BEFORE paper SQL, clientOrderId, or any hold.
  // A closed or unrecognised venue must not take funds (weekend EUR/USD used
  // to rest a funded order until Monday). Read the clock ONCE so this request
  // cannot straddle a session boundary and get two answers.
  assertMarketOpen(market, svc.now());

  // The fee tier is read once, here, and carried in the admitted payload like the rank perks: the row keeps it and a
  // tier snapshot taken after this never re-prices the order. The house market maker and a sub-account have no tier of
  // their own (sub-account volume never counts toward its parent), and only spot is tiered.
  const feeTier =
    seeded || input.subAccountId != null || market.kind !== 'spot' || market.paper ? REGULAR_FEE_TIER : await svc.feeTierAt(userId);
  // Whether this order's fills count toward the person's tier, decided by the path that placed it: never for an order
  // copy trading, an algorithm or an execution child placed for them, a sub-account's, or the house market maker's.
  const tierVolume = !seeded && input.subAccountId == null && kind !== 'copy.mirror' && !isPlacedForThem(input.clientOrderId);

  // Owner schedule before paper SQL or any hold. Listing-row 10/20 is not a
  // schedule; unpublished, or no row for this market's pair group at the
  // person's fee tier, is a typed refuse (same hitch as order preview).
  await svc.assertOwnerFeeSchedulePublished(market, undefined, feeTier);

  // Paying the fee in the platform token (fee-ifc.ts): the choice and the stake discount are read once, here, before
  // paper SQL or any hold, and carried like the tier. The conversion is the one in the version each fill is charged at.
  const feeIfc = await ifcFeeAtPlacement(
    input.feeCurrency,
    input.side === 'buy' ? market.baseAsset : market.quoteAsset,
    !seeded &&
      input.subAccountId == null &&
      market.kind === 'spot' &&
      !market.paper &&
      kind !== 'copy.mirror' &&
      !isPlacedForThem(input.clientOrderId),
    async () => {
      const schedule = await svc.feeScheduleAt(svc.now());
      return schedule.published === true ? schedule.ifcFee : null;
    },
    svc.ifcDiscount,
    userId,
  );

  // Ownership + revoked gate (identity S2S). Before any new row or hold — a
  // foreign or revoked id must never land on trade.orders.sub_account_id.
  // Existing clientOrderId retries return above even if identity is down;
  // they cannot create new risk and must remain recoverable.
  if (input.subAccountId != null) {
    await assertSubAccountOwned(svc.subAccounts, userId, input.subAccountId);
  }

  // Stage-1 paper isolation (academy.paper-trading): a paper market must never
  // post orderHold / tradeFill against real available balances. Live markets
  // keep the funded path below unchanged.
  if (market.paper) {
    return svc.placePaperOrderIsolated(principal, input, market, orderType, tif, lifecycleProof);
  }
  // RC-identity-01: a custodial order needs a proved email. Read per request,
  // before any hold; retries of an existing clientOrderId returned above.
  await assertEmailProved(svc.emailProof, userId);
  assertQty(market, input.qty);
  // A bracket's exit for a filled entry is neither banded nor capped: refusing it would leave the position
  // without its stop. A replacement takes the slot its original frees.
  // The exit is the one sell placed after its entry stopped resting; nothing else borrows the exemption.
  const protectiveExit =
    input.side === 'sell' &&
    (await svc.isPendingBracketExit(principal.userId, input.clientOrderId, { entryDone: true, marketId: market.id }));
  await assertOperatorRiskOnPlace(
    svc.sql,
    market,
    principal.userId,
    {
      side: input.side,
      price: input.price ?? null,
      qty: input.qty,
      protective: protectiveExit,
      rests: orderType !== 'market' && tif !== 'IOC' && tif !== 'FOK' && input.replacementOf == null && !protectiveExit,
    },
    () => svc.touch(market.id),
    !svc.allowUnpublishedPairRules,
  );

  // SD-5: seed/mm is liquidity provision only — never take liquidity (no
  // market orders, force post-only so the engine refuses unfair crosses).
  if (seeded) {
    if (orderType !== 'limit') {
      throw new TradeError('seed/mm orders must be limit post-only (liquidity provision only)', 'trade.seed_must_make');
    }
    tif = 'PO';
  }
  if (tif === 'PO' && orderType !== 'limit') {
    // Post-only is a promise to be a maker, and only a priced order can make
    // it. Refused here rather than by the engine so no hold is taken first.
    throw new TradeError('post-only requires a limit price', 'trade.invalid_price');
  }

  /**
   * The price the order is FUNDED at, which is not always the price it is
   * matched at:
   *   · limit      — its own price. Fills come in at or better than it.
   *   · market buy — a protection price derived from the best ask, and the
   *                  order is submitted as a marketable IOC limit there, so
   *                  the engine cannot fill above what was held.
   *   · market sell— hold is base quantity (no funding price). The engine
   *                  floor is the owner slippage cap under the best bid.
   *                  A caller `minProtectionPrice` may only tighten that floor.
   *                  No published floor is `trade.protection_unset`.
   *                  The owner max-order check uses the best bid (what a
   *                  sell IOC can fill), or that floor when it is higher.
   */
  let fundingPrice: Amount | null = null;
  let protectionPrice: Amount | null = null;
  // Market sell only. Limit and market-buy keep fundingPrice.
  let marketSellLimitPrice: Amount | null = null;

  if (orderType === 'limit') {
    slippageToleranceFor(input, orderType, null);
    if (input.price == null) throw new TradeError('a limit order requires a price', 'trade.invalid_price');
    assertPrice(market, input.price);
    assertNotional(market, input.price, input.qty);
    fundingPrice = input.price;
  } else if (input.side === 'buy') {
    const ask = await svc.bestAsk(market.id);
    const ownerCap = await svc.slippageCap(market.id);
    protectionPrice = protectionPriceFor(market, ask, ownerCap);
    const tolerance = slippageToleranceFor(input, orderType, ownerCap);
    if (tolerance !== null) {
      const tighter = protectionPriceFor(market, ask, tolerance);
      if (tighter < protectionPrice) protectionPrice = tighter;
    }
    if (input.maxProtectionPrice != null && input.maxProtectionPrice < protectionPrice) {
      if (input.maxProtectionPrice <= 0n) {
        throw new TradeError('maxProtectionPrice must be positive', 'trade.invalid_price');
      }
      protectionPrice = input.maxProtectionPrice;
    }
    assertNotional(market, protectionPrice, input.qty);
    fundingPrice = protectionPrice;
  } else {
    // Market sell. Hold stays base qty — fundingPrice remains null — but the
    // engine path is an IOC limit at the owner floor so a sell cannot print
    // through an unpublished or missing bid. The bid is read once and shared
    // with the owner-limit reference below.
    const bid = await svc.bestBid(market.id);
    const ownerCap = await svc.slippageCap(market.id);
    let floor = sellProtectionPriceFor(market, bid, ownerCap);
    const tolerance = slippageToleranceFor(input, orderType, ownerCap);
    if (tolerance !== null) {
      const tighter = sellProtectionPriceFor(market, bid, tolerance);
      if (tighter > floor) floor = tighter;
    }
    if (input.minProtectionPrice != null) {
      if (input.minProtectionPrice <= 0n) {
        throw new TradeError('minProtectionPrice must be positive', 'trade.invalid_price');
      }
      assertPrice(market, input.minProtectionPrice);
      if (input.minProtectionPrice > floor) floor = input.minProtectionPrice;
    }
    protectionPrice = floor;
    // A sell IOC can fill up to the best bid, so the max-order check must
    // not undervalue the order at the slippage floor. A floor above the bid
    // (a tightened minProtectionPrice) is the larger reference.
    marketSellLimitPrice = bid != null && bid > floor ? bid : floor;
  }

  // Owner pre-trade max-order limit (#4725): this is the one door every
  // placed order passes (router, replace, copy mirror, algo child). Retries of
  // an existing order returned above, so a retry is never newly refused. Paper
  // markets returned above too (no real money), and seeded MM is a system action.
  // Reduce-only orders only ever shrink a position, so they are never capped.
  // Limit and market-buy use fundingPrice. A market sell uses the best bid
  // (or the floor when that is higher), never the floor alone.
  if (!seeded && (input as { reduceOnly?: boolean }).reduceOnly !== true) {
    await svc.assertOwnerOrderLimit(market, input.qty, fundingPrice ?? marketSellLimitPrice ?? protectionPrice);
    // Owner cap on resting orders per user. Only an order that can rest counts against it.
    // A replacement takes the slot its original just freed, and a bracket exit only protects a filled entry.
    if (orderType !== 'market' && tif !== 'IOC' && tif !== 'FOK' && input.replacementOf == null) {
      await svc.assertOpenOrdersCap(userId, input.clientOrderId);
    }
  }

  // A market SELL holds base quantity, so `holdFor` ignores the price on that
  // branch — the zero is never read, and passing one is what keeps the
  // function total rather than partial.
  const hold = holdFor(market, input.side, fundingPrice ?? 0n, input.qty);

  // Rank perks are read ONCE, here, and snapshotted onto the row. Fails
  // closed — but nothing has moved yet, which is exactly why this is the
  // right place to be strict about a dependency being down.
  const perks = await svc.perks.perksOf(userId);

  const evidence = businessPayload({
    request,
    market,
    orderId,
    userId,
    orderType,
    tif,
    hold,
    perks,
    feeTier,
    tierVolume,
    feeIfc,
    protectionPrice,
    seeded,
    attribution,
    lifecycleProof,
    engineRequest: svc.toEngineRequest(orderId, userId, input, orderType, tif, protectionPrice, lifecycleProof),
  });
  await svc.admitAccountOperation(principal, kind, businessId, evidence, parentBusinessId, input.subAccountId);
  return svc.executeAdmittedOrder(evidence);
}

export async function recordedFillSequence(svc: TradeServiceInternal, marketId: string): Promise<number | undefined> {
  const rows = await svc.sql<Array<{ max_sequence: string | null }>>`
    SELECT MAX(sequence)::text AS max_sequence
      FROM trade.fills
     WHERE market_id = ${marketId}
  `;
  const raw = rows[0]?.max_sequence;
  return raw == null ? undefined : Number(raw);
}

/**
 * Refuse a new order while the engine counter is behind what is settled.
 *
 * The stored max is read again AFTER the depth reply: a delayed fill from the
 * previous engine can settle while the probe is in flight, and the reply must
 * be judged against that newer max, not the one sampled before the await.
 * This narrows the window; it does not make admission atomic with
 * settlement. A fill that settles after the second read is still caught by
 * `insertFillLeg` (#899) at settlement. No epoch or restart-safety protocol
 * is claimed here.
 *
 * Unknown is not missing: an outage, 5xx or malformed depth reply throws
 * `MatchingUnavailableError` (502), never `engine_sequence_regressed`.
 */
export async function refuseRestartedEngineSequence(svc: TradeServiceInternal, market: Market): Promise<void> {
  // A market with no stored fill is unjudged, as before: no probe.
  const before = await svc.recordedFillSequence(market.id);
  if (before === undefined) return;

  const engineSequence = await probeEngineSequence((marketId) => svc.matching.depth(marketId, 1), market.id);

  // Fills only grow, but take the max so a stale read can never lower the bar.
  const after = await svc.recordedFillSequence(market.id);
  const recordedSequence = after === undefined ? before : Math.max(before, after);
  if (judgeEngineSequence(recordedSequence, engineSequence) !== 'regression') return;

  const where =
    engineSequence === null
      ? `the engine book is missing after fills through sequence ${recordedSequence}`
      : `the engine sequence ${engineSequence} is behind settled sequence ${recordedSequence}`;
  throw new TradeError(
    `${market.symbol}: ${where}. Refusing the submit so the sequence counter does not start again and reissue a sequence stored on trade.fills.`,
    'trade.engine_sequence_regressed',
  );
}

/** Only called with the owner's immutable prepared payload, never public receipts. */
export async function executeAdmittedOrder(svc: TradeServiceInternal, evidence: Record<string, unknown>): Promise<OrderRecord> {
  const rawInput = evidence.request as Record<string, unknown>;
  const input = {
    ...rawInput,
    qty: parseAmount(String(rawInput.qty)),
    price: rawInput.price == null ? null : parseAmount(String(rawInput.price)),
  } as unknown as PlaceOrderInput;
  const rawMarket = evidence.market as Record<string, unknown>;
  const market = { ...rawMarket } as unknown as Market;
  for (const field of ['tickSize', 'lotSize', 'minQty', 'maxQty', 'minNotional'] as const) {
    (market as unknown as Record<string, unknown>)[field] = rawMarket[field] == null ? null : parseAmount(String(rawMarket[field]));
  }
  const orderId = String(evidence.orderId),
    userId = String(evidence.userId);
  const orderType = evidence.orderType as OrderType,
    tif = evidence.tif as TimeInForce;
  const rawHold = evidence.hold as { assetId: string; amount: string };
  const hold = { assetId: rawHold.assetId, amount: parseAmount(rawHold.amount) };
  const perks = evidence.perks as { feeDiscountBps: number };
  const protectionPrice = evidence.protectionPrice == null ? null : parseAmount(String(evidence.protectionPrice));
  const seeded = evidence.seeded === true;
  const attribution = evidence.attribution as AuthAttribution;
  const lifecycleProof = evidence.lifecycleProof as LifecycleAdmissionProof;
  const engineRequest = evidence.engineRequest as EngineSubmitRequest;
  if (!(await svc.findOrder(orderId))) await svc.refuseRestartedEngineSequence(market);
  // Read at admission (placeOrderInner). A payload admitted before tiers existed was placed at the regular tier, and
  // its fills count unless its client id says something placed it for the person.
  const feeTier = typeof evidence.feeTier === 'string' ? evidence.feeTier : REGULAR_FEE_TIER;
  const tierVolume =
    typeof evidence.tierVolume === 'boolean'
      ? evidence.tierVolume
      : !seeded && input.subAccountId == null && !isPlacedForThem(input.clientOrderId);
  const feeIfc = readFeeIfc(evidence.feeIfc);
  // ── 2b · THE INTENT ROW ─────────────────────────────────────────────────
  //
  // If this crashes exactly here, whose funds are stranded? Nobody's. A
  // `pending` row is an order with no ledger post behind it and no engine
  // presence, so the only correct recovery is to delete it, and that is the
  // only thing it can do.
  //
  // The row comes before the hold so that the hold is never the orphan: a
  // hold posted against an order id that exists nowhere is money nobody can
  // find. This way there is always a row pointing at the money, in every
  // interleaving.
  const inserted = await svc.sql<Array<{ id: string; created_at: Date }>>`
    INSERT INTO trade.orders (
      id, user_id, sub_account_id, market_id, client_order_id, side, type,
      price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, fee_tier, tier_volume, fee_currency, fee_ifc_discount_bps,
      protection_price, seeded, lifecycle_proof, replacement_of, replacement_request_hash, session_id, api_key_id, tag
    ) VALUES (
      ${orderId}, ${userId}, ${input.subAccountId ?? null}, ${market.id}, ${input.clientOrderId!},
      ${input.side}, ${orderType},
      ${input.price == null ? null : formatAmount(input.price)}::numeric,
      ${formatAmount(input.qty)}::numeric, 'pending', ${tif},
      ${hold.assetId}, ${formatAmount(hold.amount)}::numeric, ${perks.feeDiscountBps}, ${feeTier}, ${tierVolume},
      ${feeIfc?.tokenAsset ?? null}, ${feeIfc?.discountBps ?? null},
      ${protectionPrice === null ? null : formatAmount(protectionPrice)}::numeric,
      ${seeded}, ${JSON.stringify(lifecycleProof)}::text::jsonb,
      ${input.replacementOf ?? null}, ${input.replacementRequestHash ?? null},
      ${attribution.sessionId}, ${attribution.apiKeyId}, ${input.tag ?? null}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, created_at
  `;

  if (inserted.length === 0) {
    // Lost a race with a concurrent identical submission. The winner owns the
    // hold and the engine submission; return what it wrote.
    const raced = await svc.findOrder(orderId);
    if (raced) {
      assertSameFeeCurrency(raced, input, market);
      return assertSamePlaceCommand(raced, input, orderType, tif, seeded);
    }
    throw new TradeError(`order ${orderId} vanished between insert and read`, 'trade.order_not_found');
  }

  // Fills are charged at the version in force at this row's own `created_at`, at the row's fee tier. A version that took
  // effect between the check above and this insert is checked here, still before the hold, so it cannot leave a held
  // order that every fill refuses. Nothing is held yet, so a refusal only removes the pending row.
  try {
    await svc.assertOwnerFeeSchedulePublished(market, inserted[0]!.created_at, feeTier);
  } catch (err) {
    await svc.sql`DELETE FROM trade.orders WHERE id = ${orderId} AND status = 'pending'`;
    throw err;
  }

  // ── 3 · THE HOLD ────────────────────────────────────────────────────────
  //
  // Quote for buys, base for sells (§5.2). Keyed `order.hold:<orderId>` — a
  // business key, never a random one, so a retry finds the original post.
  try {
    await svc.ledger.post(
      withLedgerAttribution(recipes.orderHold({ orderId, userId, assetId: hold.assetId, amount: hold.amount }), attribution),
    );
  } catch (err) {
    const outcome = classifyHoldPostError(err);
    if (outcome === 'refused' || outcome === 'unsent') {
      // The ledger named a refusal, or the socket never connected. The post
      // did not commit. Guarded on pending so a concurrent open is left alone.
      await svc.sql`DELETE FROM trade.orders WHERE id = ${orderId} AND status = 'pending'`;
      throw err;
    }
    // UNKNOWN. A timeout can land after the hold is booked. Keep the row
    // and read `order.hold:<orderId>`. The row was just stamped, so an
    // absent read is still inside the in-flight bound: do not delete here.
    await svc.sql`
      UPDATE trade.orders SET status = 'hold_unknown', updated_at = now()
       WHERE id = ${orderId} AND status = 'pending'
    `;
    const read = await svc.readHoldByKey(orderId);
    if (read !== 'present') {
      const wait = read === 'absent' ? await svc.holdUnknownWaitSeconds(orderId) : null;
      svc.noteHoldUnknown({
        orderId,
        resolution: 'still_unknown',
        detail:
          read === 'absent'
            ? `order.hold read absent with ${wait}s of in-flight wait left; row kept`
            : 'order.hold post outcome unknown and getTxByKey did not answer; row kept',
      });
      throw new TradeError(
        read === 'absent'
          ? `order ${orderId} hold outcome is unknown; wait ${wait} seconds before treating an absent hold as dead`
          : `order ${orderId} hold outcome is unknown; the order is kept for recovery`,
        'trade.hold_unknown',
      );
    }
  }

  return svc.openAndSubmit(market, orderId, engineRequest);
}

/**
 * Paper market place — Stage-1 isolation.
 *
 * Records an open order with zero hold. Never calls the ledger and never
 * calls matching.submit. A later fill is refused in settleFill before any
 * trade.fills row or tradeFill post. Live placeOrder is unchanged for
 * non-paper markets.
 */
export async function placePaperOrderIsolated(
  svc: TradeServiceInternal,
  principal: Principal,
  input: PlaceOrderInput,
  market: Market,
  orderType: OrderType,
  tif: TimeInForce,
  lifecycleProof: LifecycleAdmissionProof,
): Promise<OrderRecord> {
  requireScope(principal, 'trade:write');
  const attribution = attributionFromPrincipal(principal);
  const userId = principal.userId;
  if (input.subAccountId != null) {
    await assertSubAccountOwned(svc.subAccounts, userId, input.subAccountId);
  }
  // Session already sealed in placeOrderInner (one clock). Do not re-read now().
  assertQty(market, input.qty);
  if (orderType === 'limit') {
    if (input.price == null) throw new TradeError('a limit order requires a price', 'trade.invalid_price');
    assertPrice(market, input.price);
    assertNotional(market, input.price, input.qty);
  }
  // Schema requires hold columns; paper posts zero amount and never ledger-posts.
  const holdAsset = input.side === 'buy' ? market.quoteAsset : market.baseAsset;
  // Caller already required clientOrderId in placeOrder — never random here.
  const orderId = orderIdFor(userId, market.id, input.clientOrderId as string);
  const existing = await svc.findOrder(orderId);
  if (existing) return assertSamePlaceCommand(existing, input, orderType, tif, false);

  const inserted = await svc.sql<Array<{ id: string }>>`
    INSERT INTO trade.orders (
      id, user_id, sub_account_id, market_id, client_order_id, side, type,
      price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, protection_price, seeded, lifecycle_proof,
      replacement_of, replacement_request_hash, session_id, api_key_id, tag
    ) VALUES (
      ${orderId}, ${userId}, ${input.subAccountId ?? null}, ${market.id}, ${input.clientOrderId as string},
      ${input.side}, ${orderType},
      ${input.price == null ? null : formatAmount(input.price)}::numeric,
      ${formatAmount(input.qty)}::numeric, 'open', ${tif},
      ${holdAsset}, ${formatAmount(0n)}::numeric, 0,
      null,
      false, ${JSON.stringify(lifecycleProof)}::text::jsonb,
      ${input.replacementOf ?? null}, ${input.replacementRequestHash ?? null},
      ${attribution.sessionId}, ${attribution.apiKeyId}, ${input.tag ?? null}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) {
    const raced = await svc.findOrder(orderId);
    if (raced) return assertSamePlaceCommand(raced, input, orderType, tif, false);
    throw new TradeError(`order ${orderId} vanished between insert and read`, 'trade.order_not_found');
  }
  // No ledger.post and no matching.submit. A zero-hold paper order on the
  // live book is how a later fill posts tradeFill against an unfunded hold.
  const settled = await svc.findOrder(orderId);
  if (!settled) throw new TradeError(`order ${orderId} vanished during paper place`, 'trade.order_not_found');
  await svc.publishOrderUpdated(settled);
  return settled;
}

/** A retry under the same client id that asks for another fee currency is another order. */
function assertSameFeeCurrency(order: OrderRecord, input: PlaceOrderInput, market: Market): void {
  if (!sameFeeCurrency(order.feeCurrency, input.feeCurrency, input.side === 'buy' ? market.baseAsset : market.quoteAsset)) {
    throw new TradeError('clientOrderId was already used for a different order request', 'trade.client_order_id_conflict');
  }
}

/** The admitted payload's token choice. A payload admitted before the choice existed paid in the received asset. */
function readFeeIfc(raw: unknown): IfcPlacement | null {
  if (raw == null || typeof raw !== 'object') return null;
  const { tokenAsset, discountBps } = raw as { tokenAsset?: unknown; discountBps?: unknown };
  if (typeof tokenAsset !== 'string' || typeof discountBps !== 'number') return null;
  return { tokenAsset, discountBps };
}
