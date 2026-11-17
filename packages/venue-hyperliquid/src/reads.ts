import { abs, compare, div, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  type AsOf,
  type MaybeKnown,
  type UserVenueAccount,
  type UserVenueAgent,
  type UserVenueBalance,
  type UserVenueFill,
  type UserVenueLeverage,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenueOrderRecord,
  type UserVenuePosition,
  type UserVenueWithdrawal,
  type VenueBook,
  type VenueBookLevel,
  type VenueOrderStatus,
  type VenueTimeInForce,
} from '@intafaced/venue-contracts';
import {
  BPS_PER_X,
  FILLS_PAGE_CAP,
  HyperliquidCore,
  PERP_COLLATERAL_ASSET,
  PERP_QUOTE,
  amt,
  arr,
  int,
  obj,
  refusal,
  str,
  type HlBook,
  type HlBookLevel,
  type HyperliquidTestnetOptions,
  type Json,
} from './core.js';
import { unreadMarketTerms, type ReadMarketTerms } from './market-terms.js';
import { rateToBps, tenthsToBps, unit, PERP_MAX_DECIMALS, SPOT_MAX_DECIMALS } from './wire.js';

/**
 * Every read the Hyperliquid testnet adapter answers from `POST /info`: the listing as `UserVenueMarket`s, the book and
 * mids, and the account's balances, orders, fills, positions, withdrawals, builder-fee approval, agents and leverage.
 * A new `UserVenue` read goes here, never in `venue.ts`.
 */
export abstract class HyperliquidReads extends HyperliquidCore {
  protected constructor(options: HyperliquidTestnetOptions) {
    super(options);
  }

  async markets(account: UserVenueAccount | null): Promise<AsOf<readonly UserVenueMarket[]>> {
    const { bySymbol } = await this.loadMarkets();
    let fees: { [key: string]: Json } | null = null;
    if (account) fees = obj(await this.info({ type: 'userFees', user: this.user(account) }), 'userFees');
    const fee = (field: string): MaybeKnown<Amount> =>
      fees && typeof fees[field] === 'string' ? { known: true, value: rateToBps(fees[field]) } : { known: false };
    const list: UserVenueMarket[] = [...bySymbol.values()].map((m) => {
      const read: ReadMarketTerms = {
        symbol: m.symbol,
        kind: m.kind,
        baseAsset: m.base,
        quoteAsset: m.quote,
        orderTypes: ['limit', 'market'],
        timeInForce: ['GTC', 'IOC', 'ALO'],
        marginModes: m.kind === 'spot' ? [] : m.onlyIsolated ? ['isolated'] : ['cross', 'isolated'],
        maxLeverageBps: m.maxLeverage === null ? null : m.maxLeverage * BPS_PER_X,
        // The finest price step a non-integer price may use; the venue also caps prices at 5 significant figures.
        tickSize: unit((m.kind === 'spot' ? SPOT_MAX_DECIMALS : PERP_MAX_DECIMALS) - m.szDecimals),
        lotSize: unit(m.szDecimals),
        makerFeeBps: fee(m.kind === 'spot' ? 'userSpotAddRate' : 'userAddRate'),
        takerFeeBps: fee(m.kind === 'spot' ? 'userSpotCrossRate' : 'userCrossRate'),
      };
      // What this adapter does not read from the venue: `market-terms.ts`, never here.
      return { ...read, ...unreadMarketTerms() };
    });
    return this.asOf(list);
  }

  /**
   * The venue's top-of-book levels for `symbol` (`l2Book`), best first: bids high to low, asks low to high.
   * A read for hand-run tools (the live conformance runner picks prices from it); not part of `UserVenue`.
   */
  async l2Book(symbol: string): Promise<AsOf<HlBook>> {
    const m = await this.market(symbol);
    const book = obj(await this.info({ type: 'l2Book', coin: m.coin }), 'l2Book');
    const [bids, asks] = arr(book.levels, 'l2Book levels');
    const side = (levels: Json | undefined, what: string): HlBookLevel[] =>
      arr(levels, what).map((l) => {
        const level = obj(l, `${what}[]`);
        return { price: amt(level.px, 'px'), size: amt(level.sz, 'sz') };
      });
    return this.asOf(
      { symbol: m.symbol, bids: side(bids, 'bids'), asks: side(asks, 'asks') },
      typeof book.time === 'number' ? book.time : undefined,
    );
  }

  /**
   * `UserVenue.book`: the top `depth` levels of each side of the venue's own book for `symbol`, from `l2Book`, best
   * first. `unknown_market` for a symbol it does not list, `venue_down` when the read fails.
   */
  async book(symbol: string, depth: number): Promise<AsOf<VenueBook>> {
    if (!Number.isSafeInteger(depth) || depth < 1) throw new RangeError(`book depth must be a whole number above 0, not ${depth}`);
    const read = await this.l2Book(symbol);
    const side = (levels: readonly HlBookLevel[]): VenueBookLevel[] =>
      levels.slice(0, depth).map((l) => ({ price: l.price, amount: l.size }));
    return { ...read, value: { symbol: read.value.symbol, bids: side(read.value.bids), asks: side(read.value.asks) } };
  }

  /** The venue's mid price of every listed market (`allMids`), by our symbol. A coin we do not list is left out. */
  async mids(): Promise<AsOf<ReadonlyMap<string, Amount>>> {
    const { byCoin } = await this.loadMarkets();
    const answer = obj(await this.info({ type: 'allMids' }), 'allMids');
    const out = new Map<string, Amount>();
    for (const [coin, px] of Object.entries(answer)) {
      const m = byCoin.get(coin);
      if (m) out.set(m.symbol, amt(px, `mid of ${coin}`));
    }
    return this.asOf(out);
  }

  // ── account reads ──────────────────────────────────────────────────────

  async balances(account: UserVenueAccount): Promise<AsOf<readonly UserVenueBalance[]>> {
    const user = this.user(account);
    const [perp, spot] = await Promise.all([
      this.info({ type: 'clearinghouseState', user }),
      this.info({ type: 'spotClearinghouseState', user }),
    ]);
    const p = obj(perp, 'clearinghouseState');
    const summary = obj(p.marginSummary, 'marginSummary');
    const accountValue = amt(summary.accountValue, 'accountValue');
    const withdrawable = amt(p.withdrawable, 'withdrawable');
    const list: UserVenueBalance[] = [];
    for (const b of arr(obj(spot, 'spotClearinghouseState').balances, 'spot balances')) {
      const bal = obj(b, 'spot balance');
      const total = amt(bal.total, 'spot total');
      const hold = amt(bal.hold, 'spot hold');
      list.push({ asset: str(bal.coin, 'spot coin'), free: sub(total, hold), locked: hold, total });
    }
    if (accountValue !== ZERO || withdrawable !== ZERO) {
      // The venue reports the perp account's value and what can be withdrawn; what is held is the difference.
      list.push({ asset: PERP_COLLATERAL_ASSET, free: withdrawable, locked: sub(accountValue, withdrawable), total: accountValue });
    }
    list.sort((a, b) => a.asset.localeCompare(b.asset));
    return this.asOf(list, typeof p.time === 'number' ? p.time : undefined);
  }

  private async toOrder(
    account: UserVenueAccount,
    raw: { [key: string]: Json },
    status: VenueOrderStatus | null,
    leverageOf: (coin: string) => Promise<number | null>,
  ): Promise<UserVenueOrder> {
    const coin = str(raw.coin, 'order coin');
    const m = await this.marketOfCoin(coin);
    const price = amt(raw.limitPx, 'limitPx');
    const remaining = amt(raw.sz, 'sz');
    const original = raw.origSz !== undefined ? amt(raw.origSz, 'origSz') : remaining;
    const filled = sub(original, remaining);
    const side = raw.side === 'B' ? 'buy' : 'sell';
    const orderType = typeof raw.orderType === 'string' ? raw.orderType : 'Limit';
    const tif: VenueTimeInForce = raw.tif === 'Ioc' ? 'IOC' : raw.tif === 'Alo' ? 'ALO' : 'GTC';
    const resolved: VenueOrderStatus = status ?? (compare(filled, ZERO) > 0 ? 'partially_filled' : 'open');
    const live = resolved === 'open' || resolved === 'partially_filled';
    let locked = ZERO;
    let lockedAsset = m?.quote ?? PERP_QUOTE;
    if (m && live) {
      if (m.kind === 'spot') {
        // The venue holds the quote notional of a resting buy and the base of a resting sell.
        if (side === 'buy') locked = mul(price, remaining, 'ceil');
        else {
          locked = remaining;
          lockedAsset = m.base;
        }
      } else {
        lockedAsset = PERP_COLLATERAL_ASSET;
        const lev = raw.reduceOnly === true ? null : await leverageOf(coin);
        // Initial margin of the open part at the account's leverage: our reading of the venue's rule, not a figure it reports.
        if (lev !== null) locked = div(mul(price, remaining, 'ceil'), parseAmount(String(lev)), 'ceil');
      }
    }
    return {
      venueOrderId: raw.oid !== undefined ? String(int(raw.oid, 'oid')) : null,
      venueClientOrderId: typeof raw.cloid === 'string' ? raw.cloid.toLowerCase() : null,
      symbol: m?.symbol ?? coin,
      side,
      type: /market/i.test(orderType) ? 'market' : 'limit',
      timeInForce: tif,
      price,
      amount: original,
      filled,
      remaining: live ? remaining : ZERO,
      averagePrice: null,
      status: resolved,
      locked,
      lockedAsset,
      reduceOnly: raw.reduceOnly === true,
    };
  }

  private leverageLookup(account: UserVenueAccount): (coin: string) => Promise<number | null> {
    const seen = new Map<string, Promise<number | null>>();
    return (coin) => {
      if (!seen.has(coin)) {
        seen.set(
          coin,
          this.info({ type: 'activeAssetData', user: this.user(account), coin }).then((d) => {
            const lev = obj(d, 'activeAssetData').leverage;
            return lev ? int(obj(lev, 'leverage').value, 'leverage value') : null;
          }),
        );
      }
      return seen.get(coin)!;
    };
  }

  async openOrders(account: UserVenueAccount): Promise<AsOf<readonly UserVenueOrder[]>> {
    const raw = arr(await this.info({ type: 'frontendOpenOrders', user: this.user(account) }), 'open orders');
    const lev = this.leverageLookup(account);
    const list: UserVenueOrder[] = [];
    for (const r of raw) list.push(await this.toOrder(account, obj(r, 'open order'), null, lev));
    return this.asOf(list);
  }

  /**
   * The account's order history (J-cex-spot-06 #1): Hyperliquid's `historicalOrders`, its 2000 most recent orders, each
   * the order as last reported with its status. An open entry's part-filled state comes from its sizes; the time placed is
   * the order's own `timestamp`. Newest placed first.
   */
  async orderHistory(account: UserVenueAccount): Promise<AsOf<readonly UserVenueOrderRecord[]>> {
    const raw = arr(await this.info({ type: 'historicalOrders', user: this.user(account) }), 'historical orders');
    const lev = this.leverageLookup(account);
    const list: UserVenueOrderRecord[] = [];
    for (const entry of raw) {
      const wrapped = obj(entry, 'historical order');
      const order = obj(wrapped.order, 'historical order.order');
      const status = mapOrderStatus(str(wrapped.status, 'historical order status'));
      list.push({
        order: await this.toOrder(account, order, status === 'open' ? null : status, lev),
        placedAt: new Date(int(order.timestamp, 'order timestamp')),
      });
    }
    list.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());
    return this.asOf(list);
  }

  async orderByClientId(account: UserVenueAccount, cloid: string): Promise<AsOf<UserVenueOrder | null>> {
    const answer = obj(await this.info({ type: 'orderStatus', user: this.user(account), oid: cloid.toLowerCase() }), 'orderStatus');
    if (answer.status === 'unknownOid') return this.asOf(null);
    const wrapped = obj(answer.order, 'orderStatus.order');
    const venueStatus = str(wrapped.status, 'order status');
    const raw = obj(wrapped.order, 'orderStatus.order.order');
    const status = mapOrderStatus(venueStatus);
    // An open order's part-filled state comes from its sizes.
    const order = await this.toOrder(account, raw, status === 'open' ? null : status, this.leverageLookup(account));
    return this.asOf(order, typeof wrapped.statusTimestamp === 'number' ? wrapped.statusTimestamp : undefined);
  }

  /**
   * Every fill since `since`. The venue caps one answer at `FILLS_PAGE_CAP`
   * fills (and keeps only the 10000 most recent), so this pages: each next
   * page starts at the last fill's millisecond, not after it, so fills that
   * share that millisecond are neither dropped nor counted twice (deduped by
   * the fill id, `fillIdOf`). It stops on a short page, or a page that adds nothing.
   * The docs' general pagination note says ranged answers return 500
   * elements; the per-endpoint 2000 is the one used, and the "adds nothing"
   * stop keeps a smaller cap from looping.
   */
  async fills(account: UserVenueAccount, since: Date): Promise<AsOf<readonly UserVenueFill[]>> {
    const seen = new Map<string, { [key: string]: Json }>();
    let startTime = since.getTime();
    for (;;) {
      const page = arr(await this.info({ type: 'userFillsByTime', user: this.user(account), startTime, aggregateByTime: false }), 'fills');
      let added = 0;
      let lastTime = startTime;
      for (const entry of page) {
        const f = obj(entry, 'fill');
        const id = fillIdOf(f);
        lastTime = Math.max(lastTime, int(f.time, 'fill time'));
        if (!seen.has(id)) {
          seen.set(id, f);
          added += 1;
        }
      }
      if (page.length < FILLS_PAGE_CAP || added === 0) break;
      if (lastTime === startTime) {
        // A full page all in one millisecond: the next page would be the same one. Refuse loudly rather than drop fills.
        throw refusal(this.venue.id, 'venue_rejected', `more than ${FILLS_PAGE_CAP} fills at ${startTime}: cannot page past them`);
      }
      startTime = lastTime;
    }
    const list: (UserVenueFill & { readonly tid: string })[] = [];
    for (const [fillId, f] of seen) {
      const coin = str(f.coin, 'fill coin');
      const m = await this.marketOfCoin(coin);
      const totalFee = amt(f.fee, 'fill fee');
      const builderFee = f.builderFee !== undefined ? amt(f.builderFee, 'fill builderFee') : ZERO;
      const dir = typeof f.dir === 'string' ? f.dir : '';
      const perp = m?.kind === 'perpetual';
      list.push({
        fillId,
        tid: String(int(f.tid, 'tid')),
        venueClientOrderId: typeof f.cloid === 'string' ? f.cloid.toLowerCase() : null,
        symbol: m?.symbol ?? coin,
        side: f.side === 'B' ? 'buy' : 'sell',
        price: amt(f.px, 'fill px'),
        amount: amt(f.sz, 'fill sz'),
        role: f.crossed === true ? 'taker' : 'maker',
        // The venue's `fee` includes the builder fee (our reading; checked on the live run): the venue's own line is the rest.
        venueFee: sub(totalFee, builderFee),
        builderFee,
        feeAsset: str(f.feeToken, 'feeToken'),
        realisedPnl: perp && !dir.startsWith('Open') ? amt(f.closedPnl, 'closedPnl') : null,
        filledAt: new Date(int(f.time, 'fill time')),
      });
    }
    list.sort(
      (x, y) =>
        x.filledAt.getTime() - y.filledAt.getTime() || compareTid(x.tid, y.tid) || (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0),
    );
    return this.asOf(list.map(({ tid: _tid, ...fill }) => fill));
  }

  async positions(account: UserVenueAccount): Promise<AsOf<readonly UserVenuePosition[]>> {
    const [state, ctxs] = await Promise.all([
      this.info({ type: 'clearinghouseState', user: this.user(account) }),
      this.info({ type: 'metaAndAssetCtxs' }),
    ]);
    // The mark comes from the same answer's own universe: its contexts are indexed by that list, not by a cached one.
    const both = arr(ctxs, 'metaAndAssetCtxs');
    const universe = arr(obj(both[0], 'metaAndAssetCtxs meta').universe, 'metaAndAssetCtxs universe');
    const assetCtxs = arr(both[1], 'asset contexts');
    const indexOfCoin = new Map<string, number>();
    universe.forEach((u, i) => indexOfCoin.set(str(obj(u, 'universe entry').name, 'universe name'), i));
    const markOf = (coin: string): Amount | null => {
      const i = indexOfCoin.get(coin);
      const ctx = i === undefined ? undefined : assetCtxs[i];
      return ctx ? amt(obj(ctx, 'asset ctx').markPx, 'markPx') : null;
    };
    const s = obj(state, 'clearinghouseState');
    const list: UserVenuePosition[] = [];
    for (const ap of arr(s.assetPositions, 'assetPositions')) {
      const p = obj(obj(ap, 'assetPosition').position, 'position');
      const coin = str(p.coin, 'position coin');
      const szi = amt(p.szi, 'szi');
      if (szi === ZERO) continue;
      const leverage = obj(p.leverage, 'position leverage');
      const mark = markOf(coin);
      if (mark === null) throw refusal(this.venue.id, 'venue_rejected', `no mark price reported for ${coin}`);
      list.push({
        symbol: await this.symbolOfCoin(coin),
        side: compare(szi, ZERO) > 0 ? 'long' : 'short',
        size: abs(szi),
        entryPrice: amt(p.entryPx, 'entryPx'),
        markPrice: mark,
        unrealisedPnl: amt(p.unrealizedPnl, 'unrealizedPnl'),
        marginMode: leverage.type === 'isolated' ? 'isolated' : 'cross',
        margin: amt(p.marginUsed, 'marginUsed'),
        leverageBps: int(leverage.value, 'leverage value') * BPS_PER_X,
        liquidationPrice: typeof p.liquidationPx === 'string' ? { known: true, value: parseAmount(p.liquidationPx) } : { known: false },
      });
    }
    list.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return this.asOf(list, typeof s.time === 'number' ? s.time : undefined);
  }

  async withdrawal(account: UserVenueAccount, nonce: string): Promise<AsOf<UserVenueWithdrawal | null>> {
    if (!/^\d+$/.test(nonce)) throw refusal(this.venue.id, 'venue_rejected', `nonce ${nonce} is not a millisecond nonce`);
    // The ledger entry is stamped at or after the signed nonce; start a minute before it in case of clock skew.
    const startTime = Math.max(0, Number(nonce) - 60_000);
    const raw = arr(await this.info({ type: 'userNonFundingLedgerUpdates', user: this.user(account), startTime }), 'ledger updates');
    for (const entry of raw) {
      const e = obj(entry, 'ledger update');
      const delta = obj(e.delta, 'ledger delta');
      if (delta.type !== 'withdraw' || String(delta.nonce) !== nonce) continue;
      return this.asOf(
        {
          nonce,
          // The asset the intent named: withdraw3 draws on the perpetual account's USDC.
          asset: PERP_COLLATERAL_ASSET,
          amount: amt(delta.usdc, 'withdraw usdc'),
          // The venue's ledger entry names no destination: we know it only for withdrawals this instance signed and sent;
          // otherwise it is honestly unknown (null), never a made-up value.
          destination: this.withdrawalDestinations.get(nonce) ?? null,
          // The ledger shows the debit; it does not report when the bridge paid out.
          status: 'pending',
          fee: typeof delta.fee === 'string' ? { known: true, value: parseAmount(delta.fee) } : { known: false },
          // The ledger entry reports one fee and no separate network fee for the bridge's send: not known, never 0.
          networkFee: { known: false },
        },
        typeof e.time === 'number' ? e.time : undefined,
      );
    }
    return this.asOf(null);
  }

  async builderFeeApproval(account: UserVenueAccount, builder: string): Promise<AsOf<Amount>> {
    const tenths = await this.info({ type: 'maxBuilderFee', user: account.owner.toLowerCase(), builder: builder.toLowerCase() });
    return this.asOf(tenthsToBps(int(tenths, 'maxBuilderFee')));
  }

  async agents(account: UserVenueAccount): Promise<AsOf<readonly UserVenueAgent[]>> {
    const raw = arr(await this.info({ type: 'extraAgents', user: account.owner.toLowerCase() }), 'extraAgents');
    return this.asOf(
      raw.map((entry) => {
        const a = obj(entry, 'agent');
        return {
          address: str(a.address, 'agent address').toLowerCase(),
          name: typeof a.name === 'string' ? a.name : '',
          validUntil: typeof a.validUntil === 'number' ? new Date(a.validUntil) : null,
        };
      }),
    );
  }

  async leverage(account: UserVenueAccount, symbol: string): Promise<AsOf<UserVenueLeverage | null>> {
    const m = await this.market(symbol);
    if (m.kind !== 'perpetual') return this.asOf(null);
    const data = obj(await this.info({ type: 'activeAssetData', user: this.user(account), coin: m.coin }), 'activeAssetData');
    if (!data.leverage) return this.asOf(null);
    const lev = obj(data.leverage, 'leverage');
    return this.asOf({
      symbol,
      leverageBps: int(lev.value, 'leverage value') * BPS_PER_X,
      marginMode: lev.type === 'isolated' ? 'isolated' : 'cross',
    });
  }
}

/**
 * A fill's id, unique everywhere: the fill's time, its coin and the venue's trade id, `<time>:<coin>:<tid>`. The venue's
 * `tid` alone is not unique: "For a globally unique trade id, use (block_time, coin, tid)" (Hyperliquid's websocket
 * subscriptions page, read 10 Nov 2026), so two trades on different coins can share it. The id is born here and becomes
 * the builder-fee ledger key, so it must never collapse two fills into one (owner decision D6, 10 Nov 2026). Time and
 * `tid` are whole numbers, so the coin is everything between the first and the last colon, even a coin with a colon.
 */
function fillIdOf(f: { readonly [key: string]: Json }): string {
  return `${int(f.time, 'fill time')}:${str(f.coin, 'fill coin')}:${int(f.tid, 'tid')}`;
}

/** Venue trade ids are whole numbers as decimal strings: order them as numbers, without a `number`. */
function compareTid(x: string, y: string): number {
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/** The venue's order status words to ours. An unknown word is loud, never guessed. */
export function mapOrderStatus(venueStatus: string): VenueOrderStatus {
  if (venueStatus === 'open' || venueStatus === 'triggered') return 'open';
  if (venueStatus === 'filled') return 'filled';
  if (venueStatus === 'rejected' || venueStatus.endsWith('Rejected')) return 'rejected';
  if (venueStatus === 'canceled' || venueStatus.endsWith('Canceled') || venueStatus === 'scheduledCancel') return 'canceled';
  throw new Error(`venue order status "${venueStatus}" is not one this adapter knows`);
}
