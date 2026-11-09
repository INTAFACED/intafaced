import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abs, add, compare, div, formatAmount, mul, parseAmount, sub, SCALE, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  USER_SIGNED_TYPES,
  actionHash,
  l1TypedData,
  recoverTypedDataSigner,
  usdClassTransferAction,
  usdSendAction,
  userSignedTypedData,
  type FetchLike,
  type HlTypedData,
} from '../src/index.js';
import { runLiveSteps } from './live-steps.js';

/**
 * The whole live-steps run against a scripted fake Hyperliquid: `/info` and `/exchange` answered from a small venue
 * held in memory (balances, holds, resting orders, a fixed outside book, fills with fees, isolated perp positions,
 * withdrawals in the venue's ledger), with every signed action's signer recovered from its signature as the venue
 * does. No network.
 */

const a = parseAmount;
const fmt = formatAmount;
const T0 = Date.UTC(2026, 10, 9, 4, 0, 0);
/** TEST keys derived from a label. Never a real key. */
const testKey = (label: string) => keccak256(toHex(`intafaced TEST hl live steps ${label}`));
const KEYS = { trader: testKey('trader'), agent: testKey('agent'), other: testKey('other'), third: testKey('third') };
const addr = (key: Hex) => privateKeyToAccount(key).address.toLowerCase();
const TRADER = addr(KEYS.trader);
const OTHER = addr(KEYS.other);

const META = { universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }] };
const SPOT_META = {
  tokens: [
    { name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0 },
    { name: 'HYPE', szDecimals: 2, weiDecimals: 8, index: 1 },
  ],
  universe: [{ name: '@1', tokens: [1, 0], index: 1, isCanonical: false }],
};
const RATES = { userCrossRate: '0.00035', userAddRate: '0.0001', userSpotCrossRate: '0.0007', userSpotAddRate: '0.0004' };
/** The outside book: deep, fixed levels the venue's other makers keep. */
const OUTSIDE: Record<string, { bid: Amount; ask: Amount }> = {
  '@1': { bid: a('150.1'), ask: a('150.9') },
  ETH: { bid: a('2000'), ask: a('2001') },
};
const MARK = a('2000.5');
const coinOf = (asset: number) => (asset === 0 ? 'ETH' : asset === 10_001 ? '@1' : `?${asset}`);

interface Position {
  szi: Amount;
  entry: Amount;
}
interface User {
  spot: Map<string, { total: Amount; hold: Amount }>;
  cash: Amount;
  positions: Map<string, Position>;
  leverage: Map<string, { type: 'cross' | 'isolated'; value: number }>;
  builders: Map<string, number>;
  ledger: Record<string, unknown>[];
  fills: Record<string, unknown>[];
}
interface Order {
  user: string;
  coin: string;
  buy: boolean;
  px: Amount;
  orig: Amount;
  left: Amount;
  tif: string;
  reduceOnly: boolean;
  oid: number;
  cloid: string;
  status: 'open' | 'filled' | 'canceled';
  builder: { b: string; f: number } | null;
  ts: number;
}

export interface Faults {
  /** Charge this many times the published venue fee. */
  feeTimes?: Amount;
  /** Answer HTTP 500 to an `/info` read when this says so. */
  failInfo?: (type: string, venue: FakeVenue) => boolean;
  /** Refuse every order this address sends. */
  refuseOrdersFrom?: string;
}

class FakeVenue {
  readonly users = new Map<string, User>();
  readonly orders: Order[] = [];
  readonly nonces = new Map<string, Set<number>>();
  readonly exchangeCalls: Record<string, unknown>[] = [];
  private oid = 1000;
  private tid = 5000;
  constructor(
    readonly now: () => number,
    readonly faults: Faults = {},
  ) {}

  user(address: string): User {
    const key = address.toLowerCase();
    let u = this.users.get(key);
    if (!u) {
      u = { spot: new Map(), cash: ZERO, positions: new Map(), leverage: new Map(), builders: new Map(), ledger: [], fills: [] };
      this.users.set(key, u);
    }
    return u;
  }

  spot(u: User, coin: string) {
    let b = u.spot.get(coin);
    if (!b) {
      b = { total: ZERO, hold: ZERO };
      u.spot.set(coin, b);
    }
    return b;
  }

  levOf(u: User, coin: string) {
    return u.leverage.get(coin) ?? { type: 'cross' as const, value: 20 };
  }

  margin(u: User): Amount {
    let m = ZERO;
    for (const [coin, p] of u.positions) m = add(m, div(mul(abs(p.szi), p.entry), a(String(this.levOf(u, coin).value)), 'ceil'));
    return m;
  }

  upnl(u: User): Amount {
    let t = ZERO;
    for (const p of u.positions.values()) t = add(t, mul(sub(MARK, p.entry), p.szi));
    return t;
  }

  withdrawable(u: User): Amount {
    return sub(u.cash, this.margin(u));
  }

  // ── /info ──
  info(body: Record<string, unknown>): unknown {
    const type = String(body.type);
    const u = body.user ? this.user(String(body.user)) : null;
    switch (type) {
      case 'meta':
        return META;
      case 'spotMeta':
        return SPOT_META;
      case 'allMids':
        return { ETH: fmt(MARK), '@1': '150.5' };
      case 'userFees':
        return RATES;
      case 'l2Book': {
        const o = OUTSIDE[String(body.coin)]!;
        return {
          coin: body.coin,
          time: this.now(),
          levels: [[{ px: fmt(o.bid), sz: '1000', n: 3 }], [{ px: fmt(o.ask), sz: '1000', n: 3 }]],
        };
      }
      case 'clearinghouseState':
        return {
          marginSummary: { accountValue: fmt(add(u!.cash, this.upnl(u!))) },
          withdrawable: fmt(this.withdrawable(u!)),
          assetPositions: [...u!.positions].map(([coin, p]) => ({
            type: 'oneWay',
            position: {
              coin,
              szi: fmt(p.szi),
              entryPx: fmt(p.entry),
              unrealizedPnl: fmt(mul(sub(MARK, p.entry), p.szi)),
              marginUsed: fmt(div(mul(abs(p.szi), p.entry), a(String(this.levOf(u!, coin).value)), 'ceil')),
              leverage: this.levOf(u!, coin),
              liquidationPx: fmt(mul(p.entry, a('0.91'))),
            },
          })),
          time: this.now(),
        };
      case 'spotClearinghouseState':
        return {
          balances: [...u!.spot]
            .filter(([, b]) => b.total !== ZERO)
            .map(([coin, b]) => ({ coin, token: coin === 'USDC' ? 0 : 1, total: fmt(b.total), hold: fmt(b.hold) })),
        };
      case 'frontendOpenOrders':
        return this.orders.filter((o) => o.user === String(body.user).toLowerCase() && o.status === 'open').map((o) => this.wire(o));
      case 'orderStatus': {
        const o = this.orders.find((x) => x.user === String(body.user).toLowerCase() && x.cloid === String(body.oid).toLowerCase());
        if (!o) return { status: 'unknownOid' };
        return { status: 'order', order: { order: this.wire(o), status: o.status, statusTimestamp: o.ts } };
      }
      case 'userFillsByTime':
        return u!.fills.filter((f) => (f.time as number) >= Number(body.startTime));
      case 'metaAndAssetCtxs':
        return [META, [{ markPx: fmt(MARK) }]];
      case 'userNonFundingLedgerUpdates':
        return u!.ledger.filter((e) => (e.time as number) >= Number(body.startTime));
      case 'maxBuilderFee':
        return u!.builders.get(String(body.builder).toLowerCase()) ?? 0;
      case 'extraAgents':
        return [];
      case 'activeAssetData':
        return { leverage: this.levOf(u!, String(body.coin)) };
      default:
        throw new Error(`fake venue: no info ${type}`);
    }
  }

  wire(o: Order) {
    return {
      coin: o.coin,
      side: o.buy ? 'B' : 'A',
      limitPx: fmt(o.px),
      sz: fmt(o.left),
      origSz: fmt(o.orig),
      oid: o.oid,
      cloid: o.cloid,
      tif: o.tif,
      orderType: 'Limit',
      reduceOnly: o.reduceOnly,
      timestamp: o.ts,
    };
  }

  // ── /exchange ──
  async exchange(body: Record<string, unknown>): Promise<unknown> {
    this.exchangeCalls.push(body);
    const action = body.action as Record<string, unknown>;
    const nonce = Number(body.nonce);
    const sig = body.signature as { r: string; s: string; v: number };
    const signature = `${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}`;
    let typed: HlTypedData;
    switch (action.type) {
      case 'order':
      case 'cancelByCloid':
      case 'updateLeverage':
        typed = l1TypedData(actionHash(action as never, (body.vaultAddress as string | null) ?? null, BigInt(nonce)));
        break;
      case 'usdSend':
        typed = usdSendAction(String(action.destination), String(action.amount), BigInt(nonce)).typedData;
        break;
      case 'usdClassTransfer':
        typed = usdClassTransferAction(String(action.amount), action.toPerp === true, BigInt(nonce)).typedData;
        break;
      case 'withdraw3':
        typed = userSignedTypedData('HyperliquidTransaction:Withdraw', USER_SIGNED_TYPES['HyperliquidTransaction:Withdraw'], {
          hyperliquidChain: 'Testnet',
          destination: String(action.destination),
          amount: String(action.amount),
          time: BigInt(nonce),
        });
        break;
      case 'approveBuilderFee':
        typed = userSignedTypedData(
          'HyperliquidTransaction:ApproveBuilderFee',
          USER_SIGNED_TYPES['HyperliquidTransaction:ApproveBuilderFee'],
          {
            hyperliquidChain: 'Testnet',
            maxFeeRate: String(action.maxFeeRate),
            builder: String(action.builder),
            nonce: BigInt(nonce),
          },
        );
        break;
      default:
        return { status: 'err', response: `unknown action ${String(action.type)}` };
    }
    const signer = await recoverTypedDataSigner(typed, signature);
    // From here on, synchronous: two sends of one signed action are applied once.
    if (!signer) return { status: 'err', response: 'User or API Wallet does not exist.' };
    const used = this.nonces.get(signer) ?? new Set<number>();
    this.nonces.set(signer, used);
    if (used.has(nonce)) return { status: 'err', response: `Invalid nonce: duplicate nonce ${nonce}` };
    used.add(nonce);
    const u = this.user(signer);
    const ok = (response: unknown) => ({ status: 'ok', response });
    switch (action.type) {
      case 'usdSend': {
        const amt = a(String(action.amount));
        if (compare(this.withdrawable(u), amt) < 0) return { status: 'err', response: 'Insufficient balance for transfer' };
        u.cash = sub(u.cash, amt);
        const to = this.user(String(action.destination));
        to.cash = add(to.cash, amt);
        return ok({ type: 'default' });
      }
      case 'usdClassTransfer': {
        const amt = a(String(action.amount));
        const usdc = this.spot(u, 'USDC');
        if (action.toPerp === true) {
          if (compare(sub(usdc.total, usdc.hold), amt) < 0) return { status: 'err', response: 'Insufficient balance' };
          usdc.total = sub(usdc.total, amt);
          u.cash = add(u.cash, amt);
        } else {
          if (compare(this.withdrawable(u), amt) < 0) return { status: 'err', response: 'Insufficient balance' };
          u.cash = sub(u.cash, amt);
          usdc.total = add(usdc.total, amt);
        }
        return ok({ type: 'default' });
      }
      case 'withdraw3': {
        const amt = a(String(action.amount));
        if (compare(this.withdrawable(u), amt) < 0) return { status: 'err', response: 'Insufficient balance for withdrawal' };
        u.cash = sub(u.cash, amt);
        u.ledger.push({ time: this.now(), hash: '0x00', delta: { type: 'withdraw', usdc: fmt(amt), nonce, fee: '1' } });
        return ok({ type: 'default' });
      }
      case 'approveBuilderFee': {
        const builder = this.user(String(action.builder));
        if (compare(add(builder.cash, this.upnl(builder)), a('100')) < 0)
          return { status: 'err', response: 'Builder has insufficient balance to be approved.' };
        const percent = a(String(action.maxFeeRate).replace('%', ''));
        u.builders.set(String(action.builder).toLowerCase(), Number((percent * 1000n) / SCALE));
        return ok({ type: 'default' });
      }
      case 'updateLeverage':
        u.leverage.set(coinOf(Number(action.asset)), { type: action.isCross ? 'cross' : 'isolated', value: Number(action.leverage) });
        return ok({ type: 'default' });
      case 'cancelByCloid': {
        const c = (action.cancels as { asset: number; cloid: string }[])[0]!;
        const o = this.orders.find((x) => x.user === signer && x.cloid === c.cloid && x.status === 'open');
        if (!o)
          return ok({
            type: 'cancel',
            data: { statuses: [{ error: `Order was never placed, already canceled, or filled. asset=${c.asset}` }] },
          });
        this.release(o, o.left);
        o.status = 'canceled';
        o.ts = this.now();
        return ok({ type: 'cancel', data: { statuses: ['success'] } });
      }
      case 'order':
        return ok({ type: 'order', data: { statuses: [this.place(signer, u, action)] } });
    }
    return { status: 'err', response: 'unreachable' };
  }

  release(o: Order, q: Amount): void {
    if (o.coin === 'ETH') return;
    const u = this.user(o.user);
    if (o.buy) this.spot(u, 'USDC').hold = sub(this.spot(u, 'USDC').hold, mul(o.px, q));
    else this.spot(u, 'HYPE').hold = sub(this.spot(u, 'HYPE').hold, q);
  }

  place(signer: string, u: User, action: Record<string, unknown>): unknown {
    const w = (action.orders as Record<string, unknown>[])[0]!;
    const coin = coinOf(Number(w.a));
    const buy = w.b === true;
    const px = a(String(w.p));
    const sz = a(String(w.s));
    const tif = String((w.t as { limit: { tif: string } }).limit.tif);
    const cloid = String(w.c).toLowerCase();
    const builder = (action.builder as { b: string; f: number } | undefined) ?? null;
    if (this.faults.refuseOrdersFrom === signer) return { error: 'Order refused: TEST fault' };
    if (this.orders.some((o) => o.user === signer && o.cloid === cloid)) return { error: 'Order has duplicate cloid' };
    if (builder && (u.builders.get(builder.b) ?? 0) < builder.f) return { error: 'Builder fee has not been approved.' };
    const perp = coin === 'ETH';
    const reduceOnly = w.r === true;
    if (!perp) {
      const need = buy ? mul(px, sz) : sz;
      const b = this.spot(u, buy ? 'USDC' : 'HYPE');
      if (compare(sub(b.total, b.hold), need) < 0) return { error: 'Insufficient spot balance' };
    } else if (reduceOnly) {
      const p = u.positions.get(coin);
      if (!p || (buy ? compare(p.szi, ZERO) >= 0 : compare(p.szi, ZERO) <= 0))
        return { error: 'Reduce only order would increase position.' };
    } else if (compare(this.withdrawable(u), div(mul(px, sz), a(String(this.levOf(u, coin).value)), 'ceil')) < 0) {
      return { error: 'Insufficient margin to place order.' };
    }
    const order: Order = {
      user: signer,
      coin,
      buy,
      px,
      orig: sz,
      left: sz,
      tif,
      reduceOnly,
      oid: (this.oid += 1),
      cloid,
      status: 'open',
      builder,
      ts: this.now(),
    };
    this.orders.push(order);
    // Resting orders of others first, then the outside book; best price first.
    const resting = this.orders
      .filter(
        (o) =>
          o !== order &&
          o.status === 'open' &&
          o.coin === coin &&
          o.buy !== buy &&
          o.user !== signer &&
          (buy ? compare(o.px, px) <= 0 : compare(o.px, px) >= 0),
      )
      .sort((x, y) => (buy ? compare(x.px, y.px) : compare(y.px, x.px)));
    for (const maker of resting) {
      if (order.left === ZERO) break;
      const q = compare(maker.left, order.left) < 0 ? maker.left : order.left;
      this.fill(order, q, maker.px, true);
      this.fill(maker, q, maker.px, false);
      this.release(maker, q);
      maker.left = sub(maker.left, q);
      if (maker.left === ZERO) maker.status = 'filled';
      order.left = sub(order.left, q);
    }
    const outside = OUTSIDE[coin]!;
    const touch = buy ? outside.ask : outside.bid;
    if (order.left !== ZERO && (buy ? compare(touch, px) <= 0 : compare(touch, px) >= 0)) {
      this.fill(order, order.left, touch, true);
      order.left = ZERO;
    }
    order.ts = this.now();
    const filled = sub(sz, order.left);
    if (order.left === ZERO) {
      order.status = 'filled';
      return { filled: { totalSz: fmt(filled), avgPx: fmt(px), oid: order.oid } };
    }
    if (tif === 'Ioc') {
      order.status = 'canceled';
      if (filled === ZERO) return { error: 'Order could not immediately match against any resting orders.' };
      return { filled: { totalSz: fmt(filled), avgPx: fmt(px), oid: order.oid } };
    }
    if (!perp) {
      const b = this.spot(u, buy ? 'USDC' : 'HYPE');
      b.hold = add(b.hold, buy ? mul(px, order.left) : order.left);
    }
    return { resting: { oid: order.oid } };
  }

  fill(o: Order, q: Amount, px: Amount, crossed: boolean): void {
    const u = this.user(o.user);
    const perp = o.coin === 'ETH';
    const rate = a(perp ? (crossed ? RATES.userCrossRate : RATES.userAddRate) : crossed ? RATES.userSpotCrossRate : RATES.userSpotAddRate);
    const notional = mul(px, q);
    const basis = !perp && o.buy ? q : notional;
    const venueFee = mul(mul(basis, rate), this.faults.feeTimes ?? a('1'));
    const builderFee = o.builder ? div(mul(basis, a(String(o.builder.f))), a('100000')) : ZERO;
    const fee = add(venueFee, builderFee);
    let dir = o.buy ? 'Buy' : 'Sell';
    let closedPnl = ZERO;
    if (perp) {
      u.cash = sub(u.cash, fee);
      const p = u.positions.get(o.coin) ?? { szi: ZERO, entry: ZERO };
      const signed = o.buy ? q : sub(ZERO, q);
      const reducing = p.szi !== ZERO && compare(p.szi, ZERO) > 0 !== o.buy;
      if (reducing) {
        closedPnl = mul(sub(px, p.entry), compare(p.szi, ZERO) > 0 ? q : sub(ZERO, q));
        u.cash = add(u.cash, closedPnl);
        dir = compare(p.szi, ZERO) > 0 ? 'Close Long' : 'Close Short';
        p.szi = add(p.szi, signed);
      } else {
        const size = abs(p.szi);
        p.entry = div(add(mul(p.entry, size), mul(px, q)), add(size, q));
        p.szi = add(p.szi, signed);
        dir = o.buy ? 'Open Long' : 'Open Short';
      }
      if (p.szi === ZERO) u.positions.delete(o.coin);
      else u.positions.set(o.coin, p);
    } else {
      const usdc = this.spot(u, 'USDC');
      const base = this.spot(u, 'HYPE');
      if (o.buy) {
        usdc.total = sub(usdc.total, notional);
        base.total = add(base.total, sub(q, fee));
      } else {
        base.total = sub(base.total, q);
        usdc.total = add(usdc.total, sub(notional, fee));
      }
    }
    u.fills.push({
      coin: o.coin,
      px: fmt(px),
      sz: fmt(q),
      side: o.buy ? 'B' : 'A',
      time: this.now(),
      dir,
      closedPnl: fmt(closedPnl),
      oid: o.oid,
      crossed,
      fee: fmt(fee),
      tid: (this.tid += 1),
      cloid: o.cloid,
      feeToken: !perp && o.buy ? 'HYPE' : 'USDC',
      ...(builderFee !== ZERO ? { builderFee: fmt(builderFee) } : {}),
    });
  }

  fetch(): FetchLike {
    return async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (url.endsWith('/info') && this.faults.failInfo?.(String(body.type), this))
        return { ok: false, status: 500, text: async () => 'TEST fault' };
      const answer = url.endsWith('/exchange') ? await this.exchange(body) : this.info(body);
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
    };
  }
}

let dir: string;
let keyFile: string;
let evidenceFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hl-live-steps-test-'));
  keyFile = join(dir, 'keys.json');
  evidenceFile = join(dir, 'evidence.json');
  writeFileSync(keyFile, JSON.stringify(KEYS));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(faults: Faults = {}, env: Record<string, string> = {}) {
  let t = T0;
  const now = () => (t += 3);
  const fake = new FakeVenue(now, faults);
  fake.user(TRADER).cash = a('1000');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runLiveSteps({
    env: { APP_ENV: 'test', HL_TESTNET_KEY_FILE: keyFile, ...env },
    argv: ['--out', evidenceFile],
    fetch: fake.fetch(),
    clock: () => new Date(now()),
    sleep: async () => {},
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
  });
  return { code, fake, out: stdout.join('\n'), err: stderr.join('\n'), lines: stdout };
}

const stepLine = (lines: string[], id: string) => lines.find((l) => new RegExp(`^(PASS|FAIL|SKIPPED)\\s+${id}(\\s|$)`).test(l));
const STEPS = [
  'J-cex-spot-01 #6',
  'J-cex-spot-01 #7',
  'J-cex-spot-01 #8',
  'J-cex-spot-01 #9',
  'J-cex-spot-01 #10',
  'J-derivatives-01 #1',
  'J-derivatives-01 #5',
  'J-derivatives-01 #6',
  'J-derivatives-01 #7',
  'J-derivatives-01 #8',
  'J-derivatives-01 #9',
  'J-derivatives-01 #11',
  'J-cex-spot-01 #12',
];

function expectNothingOpen(fake: FakeVenue) {
  expect(fake.orders.filter((o) => o.status === 'open')).toEqual([]);
  expect([...fake.user(TRADER).positions.keys()]).toEqual([]);
}

/** Every 64-hex run in the key file, compared lowercase, so a key printed with or without 0x, in any case, is caught. */
const KEY_HEX = [...JSON.stringify(KEYS).matchAll(/[0-9a-fA-F]{64}/g)].map((m) => m[0].toLowerCase());
function expectNoKey(...texts: string[]) {
  const keys = KEY_HEX;
  expect(keys).toHaveLength(4);
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const k of keys) expect(lower.includes(k)).toBe(false);
  }
}

describe('live steps against a scripted fake venue', () => {
  it('passes every step, with the venue evidence on each line and in the evidence file; leaves nothing open', async () => {
    const { code, fake, out, err, lines } = await run();
    expect(err).toBe('');
    for (const id of STEPS) expect(stepLine(lines, id), `${id}\n${out}`).toMatch(/^PASS/);
    expect(code).toBe(0);
    // Evidence on the lines: cloids, fills, fees, as-of times.
    expect(stepLine(lines, 'J-cex-spot-01 #6')).toMatch(/cloid 0x[0-9a-f]{32}/);
    expect(stepLine(lines, 'J-cex-spot-01 #8')).toMatch(/tid \d+, 0\.08 at 150\.5, maker, venue fee [\d.]+ HYPE, builder fee [\d.]+ HYPE/);
    expect(stepLine(lines, 'J-cex-spot-01 #10')).toMatch(/repeat: not definite \(already_submitted\)/);
    expect(stepLine(lines, 'J-derivatives-01 #9')).toMatch(/as of 2026-11-09T/);
    expect(stepLine(lines, 'J-cex-spot-01 #12')).toMatch(/pending, fee 1; skipped: done \(the bridge settles/);
    expect(stepLine(lines, 'J-derivatives-01 #1')).toMatch(/skipped: venue down/);
    // The fill was crossed by "other", after "other" bought the base from the outside book.
    expect(out).toContain('setup: other bought');
    expect(out).toContain('setup: usdSend');
    expect(out).toContain('setup: usdClassTransfer');
    expect(out).toContain('cleanup: nothing left open by this run');
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as {
      steps: { verdict: string; checks: unknown[] }[];
      addresses: Record<string, string>;
    };
    expect(evidence.steps).toHaveLength(13);
    expect(evidence.steps.every((s) => s.verdict === 'PASS')).toBe(true);
    expect(evidence.addresses.trader).toBe(TRADER);
    // One order per double press: the perp open was sent twice and applied once.
    const opens = fake.orders.filter((o) => o.coin === 'ETH' && o.buy);
    expect(opens).toHaveLength(1);
    expectNothingOpen(fake);
    expectNoKey(out, err, readFileSync(evidenceFile, 'utf8'));
  });

  it('a venue fee off the published rate is a FAIL with both figures, and the exit code is 1', async () => {
    const { code, fake, lines, out } = await run({ feeTimes: a('10') });
    expect(stepLine(lines, 'J-cex-spot-01 #8')).toMatch(
      /^FAIL\s+J-cex-spot-01 #8\s+venue fee at the published maker rate: [\d.]+ HYPE; the review said [\d.]+ HYPE/,
    );
    expect(stepLine(lines, 'J-cex-spot-01 #9'), out).toMatch(/^PASS/);
    expect(code).toBe(1);
    expectNothingOpen(fake);
  });

  it('after a failure mid-run, the cleanup cancels the resting order and closes the position', async () => {
    const { code, fake, lines, out } = await run({
      refuseOrdersFrom: OTHER,
      failInfo: (type, venue) => type === 'userFillsByTime' && venue.user(TRADER).positions.size > 0,
    });
    expect(stepLine(lines, 'J-cex-spot-01 #8')).toMatch(/^FAIL/);
    expect(stepLine(lines, 'J-derivatives-01 #8')).toMatch(/^FAIL/);
    expect(stepLine(lines, 'J-derivatives-01 #9')).toMatch(
      /^SKIPPED\s+J-derivatives-01 #9\s+skipped: step \(J-derivatives-01 #8 failed first\)/,
    );
    expect(out).toMatch(/cleanup: cancelled trader's HYPE-USDC order 0x[0-9a-f]{32}: accepted \(oid \d+\), read back canceled/);
    expect(out).toMatch(/cleanup: closed long 0\.0138 ETH-PERP \(reduce-only IOC\): accepted/);
    // The position was closed before the withdrawal, so #12 still ran on a still perp balance.
    expect(out.indexOf('cleanup: closed long')).toBeLessThan(out.indexOf('J-cex-spot-01 #12'));
    expect(code).toBe(1);
    expectNothingOpen(fake);
    expectNoKey(out, readFileSync(evidenceFile, 'utf8'));
  });

  it('refuses before anything is sent: APP_ENV, mainnet, a key file without the keys', async () => {
    const live = await run({}, { APP_ENV: 'production' });
    expect(live.code).toBe(2);
    expect(live.err).toMatch(/refused/);
    const mainnet = await run({}, { HL_API_URL: 'https://api.hyperliquid.xyz' });
    expect(mainnet.code).toBe(2);
    expect(mainnet.fake.exchangeCalls).toEqual([]);
    writeFileSync(keyFile, JSON.stringify({ trader: KEYS.trader }));
    const short = await run();
    expect(short.code).toBe(2);
    expect(short.err).toContain('no "other" key');
    expect(short.fake.exchangeCalls).toEqual([]);
    expectNoKey(live.err, mainnet.err, short.err);
  });
});
