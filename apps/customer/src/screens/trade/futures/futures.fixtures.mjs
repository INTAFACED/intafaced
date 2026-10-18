// TEST DATA ONLY. Not real balances, marks or positions: the numbers are invented but consistent, and every screenshot
// taken with them is filed under harness-test/ and labelled TEST. These are WIRE shapes: the exact JSON svc-trade sends
// (services/svc-trade/src/private-rest.ts, futures/*), so the real data layer and the real client parse them.
// `FuturesExchange` is a small stateful stand-in for the futures doors so open, margin, leverage and close can be walked
// end to end. The real local service lists no futures market, which is why this exists (tasks/TRFUT-BACKEND-NEEDS.md #1).
import { markets as spotMarkets, candles, scaled, plain } from '../desk/desk.fixtures.mjs';

export const SYMBOL = 'BTC/USDT:USDT';
const SCALE = 10n ** 18n;
const mul = (a, b) => (a * b) / SCALE;
const div = (a, b) => (a * SCALE) / b;
const MARK = '65000';
const LEVERAGE_CAP = '20';
const MAINT_RATE = '0.005';

export const futuresMarket = () => ({
  id: SYMBOL,
  symbol: SYMBOL,
  base: 'BTC',
  quote: 'USDT',
  settle: 'USDT',
  baseId: 'BTC',
  quoteId: 'USDT',
  type: 'swap',
  spot: false,
  swap: true,
  future: false,
  option: false,
  contract: true,
  linear: true,
  inverse: false,
  active: true,
  orderable: true,
  paper: false,
  schedule: 'crypto-24x7',
  sessionOpen: true,
  nextSessionChange: null,
  hours: { kind: 'continuous' },
  taker: '0.0005',
  maker: '0.0002',
  contractSize: '1',
  expiry: null,
  expiryDatetime: null,
  strike: null,
  optionType: null,
  precisionMode: 'TICK_SIZE',
  precision: { amount: '0.001', price: '0.1' },
  limits: {
    amount: { min: '0.001', max: null },
    price: { min: '0.1', max: null },
    cost: { min: '5', max: null },
    leverage: { min: '1', max: LEVERAGE_CAP },
  },
  lifecycle: { state: 'OPEN' },
});

/** One wire position. Money fields are exact decimal strings. */
export function wirePosition({
  id,
  side = 'long',
  size = '0.1',
  entry = '64000',
  mark = MARK,
  leverage = '5',
  status = 'open',
  collateral,
  closingReason = null,
  at = Date.now() - 3_600_000,
  // false mirrors what svc-trade sends today (presentPosition): maintenanceMargin, unrealizedPnl, percentage, contractSize, markPrice
  // and realizedPnl are null. true shows the room reading those fields once the service sends them.
  publish = false,
}) {
  const notional = mul(scaled(size), scaled(mark));
  const entryNotional = mul(scaled(size), scaled(entry));
  const im = collateral ? scaled(collateral) : div(entryNotional, scaled(leverage));
  const maintenance = mul(notional, scaled(MAINT_RATE));
  const diff = scaled(mark) - scaled(entry);
  const pnl = mul(scaled(size), side === 'long' ? diff : -diff);
  const lev = scaled(leverage);
  const factor = side === 'long' ? SCALE - div(SCALE, lev) + scaled(MAINT_RATE) : SCALE + div(SCALE, lev) - scaled(MAINT_RATE);
  const wire = {
    id,
    symbol: SYMBOL,
    timestamp: at,
    datetime: new Date(at).toISOString(),
    side,
    status,
    closingReason,
    contracts: size,
    contractSize: '1',
    entryPrice: entry,
    markPrice: mark,
    notional: plain(notional),
    leverage,
    collateral: plain(im),
    initialMargin: plain(im),
    maintenanceMargin: plain(maintenance),
    unrealizedPnl: plain(pnl),
    realizedPnl: status === 'closed' || status === 'liquidated' ? plain(pnl) : null,
    liquidationPrice: plain(mul(scaled(entry), factor)),
    marginMode: 'isolated',
    percentage: null,
  };
  if (!publish)
    Object.assign(wire, {
      contractSize: null,
      markPrice: null,
      maintenanceMargin: null,
      unrealizedPnl: null,
      realizedPnl: null,
      percentage: null,
    });
  Object.defineProperty(wire, '_pnl', { value: plain(pnl), enumerable: false, writable: true });
  return wire;
}

export class FuturesExchange {
  constructor(opts = {}) {
    this.opts = {
      noMarkets: false,
      planeOff: false,
      fundingPublished: true,
      acknowledged: true,
      openMode: 'ok', // ok | lose (answer never arrives, request was taken)
      closeMode: 'ok', // ok | closing (no usable mark) | lose
      marginCall: null, // position id with a delivered margin call
      seed: 'two', // none | one | two | risky
      ...opts,
    };
    this.requests = [];
    this.byOpenId = new Map();
    this.closed = [];
    this.adl = this.opts.adlEvents ?? [];
    this.acked = this.opts.acknowledged;
    this.free = scaled(this.opts.free ?? '10000');
    this.positions = [];
    const seed = this.opts.seed;
    const publish = Boolean(this.opts.publishRisk);
    if (seed === 'one' || seed === 'two' || seed === 'risky')
      this.positions.push(
        wirePosition({ id: 'pos-long-1', side: 'long', size: '0.1', entry: '64000', leverage: '5', at: Date.now() - 7_200_000, publish }),
      );
    if (seed === 'two')
      this.positions.push(
        wirePosition({
          id: 'pos-short-2',
          side: 'short',
          size: '0.05',
          entry: '66000',
          leverage: '10',
          at: Date.now() - 3_600_000,
          publish,
        }),
      );
    if (seed === 'risky')
      this.positions.push(
        wirePosition({
          id: 'pos-risky-3',
          side: 'long',
          size: '0.2',
          entry: '66000',
          mark: '60000',
          leverage: '15',
          at: Date.now() - 1_800_000,
          publish,
        }),
      );
    this.closed.push(
      wirePosition({
        id: 'pos-old-1',
        side: 'long',
        size: '0.02',
        entry: '61000',
        mark: '63000',
        status: 'closed',
        at: Date.now() - 86_400_000,
        publish,
      }),
    );
    this.closed.push(
      wirePosition({
        id: 'pos-liq-2',
        side: 'short',
        size: '0.03',
        entry: '60000',
        mark: '70500',
        leverage: '20',
        status: 'liquidated',
        at: Date.now() - 172_800_000,
        publish,
      }),
    );
  }

  usedMargin() {
    return this.positions.reduce((sum, p) => sum + scaled(p.collateral), 0n);
  }

  balance() {
    const now = Date.now();
    const used = this.usedMargin();
    return {
      timestamp: now,
      datetime: new Date(now).toISOString(),
      balances: { USDT: { free: plain(this.free), used: plain(used), total: plain(this.free + used) } },
    };
  }

  find(id) {
    return this.positions.find((p) => p.id === id);
  }

  preview(body) {
    const refusals = [];
    const size = scaled(body.size ?? '0');
    const lev = scaled(body.leverage ?? '0');
    if (lev > scaled(LEVERAGE_CAP))
      refusals.push({ code: 'trade.leverage_too_high', field: 'leverage', message: `leverage is above the cap ${LEVERAGE_CAP}` });
    if (size <= 0n || lev <= 0n)
      refusals.push({ code: 'trade.position_preview_invalid', field: 'leverage', message: 'size and leverage must be above zero' });
    if (refusals.length)
      return {
        symbol: body.symbol,
        side: body.side,
        size: body.size,
        leverage: body.leverage,
        marginMode: 'isolated',
        markPrice: MARK,
        markSource: { kind: 'index' },
        leverageCap: LEVERAGE_CAP,
        orderValue: null,
        initialMargin: null,
        estimatedFee: null,
        liquidationPrice: null,
        orderable: false,
        refusals,
      };
    const value = mul(size, scaled(MARK));
    const im = div(value, lev);
    const factor = body.side === 'long' ? SCALE - div(SCALE, lev) + scaled(MAINT_RATE) : SCALE + div(SCALE, lev) - scaled(MAINT_RATE);
    return {
      symbol: body.symbol,
      side: body.side,
      size: body.size,
      leverage: body.leverage,
      marginMode: 'isolated',
      markPrice: MARK,
      markSource: { kind: 'index' },
      leverageCap: LEVERAGE_CAP,
      orderValue: plain(value),
      initialMargin: plain(im),
      estimatedFee: plain(mul(value, scaled('0.0005'))),
      liquidationPrice: plain(mul(scaled(MARK), factor)),
      orderable: im + mul(value, scaled('0.0005')) <= this.free,
      refusals:
        im + mul(value, scaled('0.0005')) <= this.free
          ? []
          : [{ code: 'trade.insufficient_margin', field: 'size', message: 'not enough free balance' }],
    };
  }

  handle({ method, path, query = {}, body }) {
    this.requests.push({ method, path, body });
    const json = (value, status = 200) => ({ status, json: value });
    const error = (code, message, status = 400) => json({ error: code, message }, status);
    if (this.opts.planeOff && path.startsWith('positions') && method !== 'GET')
      return error('trade.futures_disabled', 'futures plane is off', 403);
    if (this.opts.planeOff && (path === 'positions' || path === 'futures/ticker'))
      return error('trade.futures_disabled', 'futures plane is off', 403);
    if (path === 'markets') return json(this.opts.noMarkets ? spotMarkets() : [...spotMarkets(), futuresMarket()]);
    if (path === 'account/balance') return json(this.balance());
    if (path === 'futures/ticker') {
      const next = new Date(Date.now() + 3 * 3_600_000 + 12 * 60_000).toISOString();
      return json({
        markPrice: this.opts.markDark ? null : MARK,
        markSource: { kind: 'index' },
        fundingRate: this.opts.fundingPublished ? '0.0001' : null,
        fundingPeriodId: '2026-10-17T08',
        nextFundingTime: this.opts.fundingPublished ? next : null,
      });
    }
    if (path.startsWith('funding-rate/')) {
      if (!this.opts.fundingPublished) return json({ error: 'trade.funding_rate_unavailable', message: 'no published funding rate' }, 501);
      const now = Date.now();
      return json({
        symbol: SYMBOL,
        markPrice: MARK,
        indexPrice: '64990.5',
        fundingRate: '0.0001',
        fundingTimestamp: now - 5 * 3_600_000,
        fundingDatetime: new Date(now - 5 * 3_600_000).toISOString(),
        nextFundingTimestamp: now + 3 * 3_600_000,
      });
    }
    if (path.startsWith('ohlcv/')) return json(candles(query.timeframe ?? '15m', Number(query.limit ?? 200)));
    if (path === 'positions/preview' && method === 'POST') return json(this.preview(body));
    if (path === 'positions/closed') return json(this.closed);
    if (path === 'positions' && method === 'GET') return json(this.positions);
    if (path === 'positions' && method === 'POST') {
      const taken = this.byOpenId.get(body.clientOpenId);
      if (taken) return json(taken);
      if (scaled(body.leverage) > scaled(LEVERAGE_CAP)) return error('trade.leverage_too_high', 'leverage above cap');
      if (this.opts.openMode === 'drop' && !this.dropped) {
        this.dropped = true; // the request never reaches the service
        return 'abort';
      }
      const created = wirePosition({
        id: `pos-${this.positions.length + 10}`,
        side: body.side,
        size: body.size,
        entry: MARK,
        leverage: body.leverage,
        at: Date.now(),
        publish: Boolean(this.opts.publishRisk),
      });
      this.positions.push(created);
      this.byOpenId.set(body.clientOpenId, created);
      this.free -= scaled(created.initialMargin);
      return this.opts.openMode === 'lose' ? 'abort' : json(created);
    }
    if (path === 'futures/adl-disclosure')
      return json({
        version: 'adl-2026-10',
        copy: 'TEST copy: if the insurance fund cannot cover a bankrupt position, profitable positions on the other side may be reduced. You are told before it happens.',
        acknowledged: this.acked,
      });
    if (path === 'futures/adl-disclosure/ack') {
      this.acked = true;
      return json({ version: 'adl-2026-10', copy: 'TEST copy', acknowledged: true });
    }
    if (path === 'futures/adl-events') return json(this.adl);
    let m = path.match(/^positions\/([^/]+)\/margin-call$/);
    if (m) {
      if (this.opts.marginCall !== m[1])
        return error('trade.margin_call_not_found', 'No delivered margin call is open for this position.', 404);
      const at = Date.now() - 600_000;
      return json({
        positionId: m[1],
        userId: 'u1',
        marketId: SYMBOL,
        sequence: 1,
        healthBps: 8200,
        calledAt: new Date(at).toISOString(),
        deliveredAt: new Date(at + 1500).toISOString(),
        delivered: true,
      });
    }
    m = path.match(/^positions\/([^/]+)$/);
    if (m && method === 'GET') {
      const row = this.find(m[1]) ?? this.closed.find((p) => p.id === m[1]);
      return row ? json(row) : error('trade.position_not_found', 'not found', 404);
    }
    m = path.match(/^positions\/([^/]+)\/close$/);
    if (m && method === 'POST') {
      const pos = this.find(m[1]);
      if (!pos) return error('trade.position_not_found', 'not found', 404);
      if (typeof body.quantity !== 'string' || typeof body.clientCloseId !== 'string') {
        return error('trade.client_close_id_required', 'quantity and clientCloseId are required');
      }
      if (this.opts.closeMode === 'closing') {
        pos.status = 'closing';
        pos.closingReason = 'trade.mark_unusable';
        return json(pos);
      }
      this.positions = this.positions.filter((p) => p !== pos);
      this.free += scaled(pos.collateral) + scaled(pos._pnl);
      const done = { ...pos, status: 'closed', realizedPnl: this.opts.publishRisk ? pos._pnl : null };
      this.closed.unshift(done);
      return this.opts.closeMode === 'lose' ? 'abort' : json(done);
    }
    if (path === 'futures/leverage' || path === 'positions/leverage') {
      const pos = this.find(body.positionId);
      if (!pos) return error('trade.position_not_found', 'not found', 404);
      if (scaled(body.leverage) > scaled(LEVERAGE_CAP)) return error('trade.leverage_too_high', 'leverage above cap');
      Object.assign(
        pos,
        wirePosition({
          id: pos.id,
          side: pos.side,
          size: pos.contracts,
          entry: pos.entryPrice,
          leverage: body.leverage,
          at: pos.timestamp,
          publish: Boolean(this.opts.publishRisk),
        }),
      );
      return json(pos);
    }
    if (path === 'positions/margin' || path === 'positions/margin/reduce') {
      const pos = this.find(body.positionId);
      if (!pos) return error('trade.position_not_found', 'not found', 404);
      const amount = scaled(body.amount);
      const reduce = path.endsWith('/reduce');
      if (!reduce && amount > this.free) return error('trade.insufficient_margin', 'not enough free balance');
      if (reduce && scaled(pos.collateral) - amount < scaled(pos.initialMargin) - scaled(pos.initialMargin) / 2n)
        return error('trade.margin_below_initial', 'below initial margin');
      pos.collateral = plain(scaled(pos.collateral) + (reduce ? -amount : amount));
      this.free += reduce ? amount : -amount;
      return json(pos);
    }
    return json({ error: 'trade.not_mounted', message: `no fixture for ${method} ${path}` }, 404);
  }
}
