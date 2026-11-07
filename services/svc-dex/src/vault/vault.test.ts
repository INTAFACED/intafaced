/**
 * Wallet orders and their keeper (D-limit-dca-01 to -04), against a fake vault chain that applies the contract's own
 * rules (remaining only goes down, a linked group shares one remaining, a fill pays at least its floor, the trigger is
 * checked against the oracle, expiry, cancel). The bytecode itself is exercised by svc-protocol's on-chain test and the
 * journey; this file proves the service's validation, signatures, state machine and saga.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, encodeAbiParameters, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { OrderPrincipal } from '../auth/order-session.js';
import type { PoolState, PriceRead, Receipt, VaultChain } from './chain.js';
import { floorFor, largestTake, OrderKeeper, poolOut } from './keeper.js';
import { ZERO32, type ChainOrder, type OrderPair } from './model.js';
import { WalletOrders, priceText } from './orders.js';
import { WalletOrderStore } from './store.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const maker = privateKeyToAccount(KEY);
const VAULT = '0x00000000000000000000000000000000000000aa' as Address;
const A = getAddress('0x00000000000000000000000000000000000a11ce');
const B = getAddress('0x00000000000000000000000000000000000b0b00');
const POOL = getAddress('0x00000000000000000000000000000000000000bb');
const pair: OrderPair = {
  base: { address: A, symbol: 'TEST A', decimals: 6 },
  quote: { address: B, symbol: 'TEST B', decimals: 18 },
  pool: POOL,
};
const WAD = 10n ** 18n;
const a = (n: string) => BigInt(Math.round(Number(n) * 1e6));
const b = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

const principal: OrderPrincipal = {
  wallet: maker.address.toLowerCase(),
  sessionId: 's1',
  cap: [
    { token: A.toLowerCase(), symbol: 'TEST A', max: '10000' },
    { token: B.toLowerCase(), symbol: 'TEST B', max: '10000' },
  ],
};

const idOf = (o: ChainOrder) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(o.maker), o.nonce])).toLowerCase() as Hex;
const groupOf = (o: ChainOrder) =>
  o.link === ZERO32 ? idOf(o) : keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [getAddress(o.maker), o.link]));

/** The vault's rules, in memory. */
class FakeChain implements VaultChain {
  readonly wired = true;
  readonly vault = VAULT;
  readonly chainId = 84532;
  time = 1_800_000_000n;
  priceWad: bigint | 'stale' = WAD;
  reserves = { a: a('1000000'), b: b('1000000') };
  credits = new Map<string, bigint>();
  filled = new Map<string, bigint>();
  bought = new Map<string, bigint>();
  cancelled = new Set<string>();
  watermarks = new Map<string, bigint>();
  receipts = new Map<Hex, Receipt>();
  sent: { take: bigint; order: ChainOrder }[] = [];
  private n = 0;
  creditKey = (m: string, t: string) => `${m.toLowerCase()}:${t.toLowerCase()}`;
  setCredit(token: Address, amount: bigint) {
    this.credits.set(this.creditKey(maker.address, token), amount);
  }
  async credit(m: string, t: string) {
    return this.credits.get(this.creditKey(m, t)) ?? 0n;
  }
  async uncredited() {
    return 0n;
  }
  async strays() {
    return 0n;
  }
  async price(): Promise<PriceRead> {
    return this.priceWad === 'stale' ? { status: 'stale' } : { status: 'ok', priceWad: this.priceWad };
  }
  async watermark(o: ChainOrder) {
    return this.watermarks.get(idOf(o)) ?? 0n;
  }
  async remaining(o: ChainOrder) {
    if (this.cancelled.has(idOf(o))) return 0n;
    const used = this.filled.get(groupOf(o)) ?? 0n;
    let left = o.amountIn > used ? o.amountIn - used : 0n;
    if (o.parent !== ZERO32) {
      const cover = (this.bought.get(o.parent) ?? 0n) - used;
      if (cover < left) left = cover > 0n ? cover : 0n;
    }
    return left;
  }
  async boughtOut(id: Hex) {
    return this.bought.get(id) ?? 0n;
  }
  async pool(_p: string, tokenIn: string): Promise<PoolState> {
    const aIn = getAddress(tokenIn) === A;
    return { reserveIn: aIn ? this.reserves.a : this.reserves.b, reserveOut: aIn ? this.reserves.b : this.reserves.a, feeBps: 30n };
  }
  private check(o: ChainOrder, take: bigint) {
    if (this.priceWad === 'stale') return 'Stale';
    if (this.time > o.expiry) return 'OrderExpired';
    const trigger = o.trailBps > 0n ? ((this.watermarks.get(idOf(o)) ?? 0n) * (10_000n - o.trailBps)) / 10_000n : o.triggerWad;
    if (o.above ? this.priceWad < trigger : this.priceWad > trigger) return 'TriggerNotReached';
    return null;
  }
  async simulateFill(o: ChainOrder, _s: Hex, take: bigint) {
    const why = this.check(o, take);
    return why ? { ok: false as const, reason: why } : { ok: true as const, out: 0n };
  }
  async sendFill(o: ChainOrder, _s: Hex, take: bigint): Promise<Hex> {
    const hash = `0x${(++this.n).toString(16).padStart(64, '0')}` as Hex;
    this.sent.push({ take, order: o });
    const remaining = await this.remaining(o);
    const pool = await this.pool(POOL, o.isBuy ? B : A);
    const out = poolOut(take, pool.reserveIn, pool.reserveOut, 30n);
    if (this.check(o, take) || take > remaining || out < floorFor(o, take)) {
      this.receipts.set(hash, { status: 'reverted' });
      return hash;
    }
    this.filled.set(groupOf(o), (this.filled.get(groupOf(o)) ?? 0n) + take);
    const tIn = o.isBuy ? B : A;
    this.credits.set(this.creditKey(o.maker, tIn), (this.credits.get(this.creditKey(o.maker, tIn)) ?? 0n) - take);
    if (o.isBuy) {
      this.reserves = { a: this.reserves.a - out, b: this.reserves.b + take };
    } else {
      this.reserves = { a: this.reserves.a + take, b: this.reserves.b - out };
    }
    if (o.outputToVault) this.bought.set(idOf(o), (this.bought.get(idOf(o)) ?? 0n) + out);
    this.receipts.set(hash, { status: 'success', filled: { amountIn: take, amountOut: out, priceWad: this.priceWad as bigint } });
    this.fillHashes.set(idOf(o), [...(this.fillHashes.get(idOf(o)) ?? []), hash]);
    if (this.throwAfterSend) {
      this.throwAfterSend = false;
      throw new Error('The request took too long to respond.');
    }
    return hash;
  }
  async sendPoke(o: ChainOrder): Promise<Hex> {
    const mark = this.watermarks.get(idOf(o)) ?? 0n;
    if (this.priceWad !== 'stale' && (mark === 0n || this.priceWad > mark)) this.watermarks.set(idOf(o), this.priceWad);
    const hash = `0x${(++this.n).toString(16).padStart(64, '0')}` as Hex;
    this.receipts.set(hash, { status: 'success' });
    return hash;
  }
  async sendSweep(): Promise<Hex> {
    throw new Error('not in this test');
  }
  async receipt(hash: Hex) {
    return this.receipts.get(hash) ?? { status: 'pending' as const };
  }
  /** When set, the next fill is mined and then the send throws, as a node that times out after taking it. */
  throwAfterSend = false;
  fillHashes = new Map<string, Hex[]>();
  async fillTxs(o: ChainOrder) {
    return this.fillHashes.get(idOf(o)) ?? [];
  }
  async now() {
    return this.time;
  }
}

const SETTINGS = {
  pairs: [pair],
  minSize: 1n * WAD,
  slippageBps: 50,
  restrictedTokens: [] as string[],
  trailBounds: { min: 100, max: 2000 },
};

function world() {
  const chain = new FakeChain();
  const store = new WalletOrderStore(mkdtempSync(join(tmpdir(), 'dex-vault-')));
  const orders = new WalletOrders(store, chain, SETTINGS);
  const keeper = new OrderKeeper({ store, chain, pairs: [pair], now: () => new Date() });
  return { chain, store, orders, keeper };
}

async function place(orders: WalletOrders, input: Parameters<WalletOrders['prepare']>[1], key: Hex = KEY) {
  const prepared = await orders.prepare(principal, input);
  const signatures: Hex[] = [];
  for (const o of prepared.orders) {
    const { EIP712Domain: _d, ...types } = o.typedData.types;
    signatures.push(
      await privateKeyToAccount(key).signTypedData({
        domain: o.typedData.domain,
        types,
        primaryType: 'Order',
        message: o.typedData.message,
      } as never),
    );
  }
  return orders.create(principal, prepared.draftId, signatures);
}

describe('pool sizing', () => {
  it('finds the largest take the pool pays the floor for, and nothing past it', () => {
    const order = { amountIn: a('100'), minOut: b('124.375') } as ChainOrder;
    const rIn = a('1000');
    // A quote reserve that just pays the floor for 40.
    let rOut = 1n;
    let hi = 10n ** 30n;
    while (hi - rOut > 1n) {
      const mid = (rOut + hi) / 2n;
      if (poolOut(a('40'), rIn, mid, 30n) >= floorFor(order, a('40'))) hi = mid;
      else rOut = mid;
    }
    expect(largestTake(order, a('100'), rIn, hi, 30n)).toBe(a('40'));
    expect(largestTake(order, a('100'), rIn, 1n, 30n)).toBe(0n);
  });
  it('a buy from an 18-decimal token into a 6-decimal one still finds its take, though one wei buys nothing', () => {
    // Floor 0.8 TEST A per TEST B; the pool pays that only up to about 24.7 TEST B in.
    const order = { amountIn: b('50'), minOut: a('40') } as ChainOrder;
    const [rIn, rOut] = [b('100'), a('100')];
    expect(poolOut(1n, rIn, rOut, 30n)).toBe(0n);
    const take = largestTake(order, b('50'), rIn, rOut, 30n);
    expect(take).toBeGreaterThan(b('24'));
    expect(poolOut(take, rIn, rOut, 30n)).toBeGreaterThanOrEqual(floorFor(order, take));
    expect(poolOut(take + 1n, rIn, rOut, 30n)).toBeLessThan(floorFor(order, take + 1n));
  });
  it('prints prices with two to six decimals', () => {
    expect(priceText(13n * 10n ** 17n)).toBe('1.30');
    expect(priceText(8075n * 10n ** 14n)).toBe('0.8075');
  });
});

describe('placing (D-limit-dca-02, -03)', () => {
  it('a price order with no expiry is refused; below the minimum is refused; with no credit it is refused', async () => {
    const { orders, chain } = world();
    await expect(orders.prepare(principal, { kind: 'sell_above', side: 'sell', amount: '100', trigger: '1.25' })).rejects.toMatchObject({
      code: 'dex.order.expiry_required',
    });
    await expect(
      orders.prepare(principal, { kind: 'sell_above', side: 'sell', amount: '0.5', trigger: '1.25', expiryHours: '24' }),
    ).rejects.toMatchObject({
      code: 'dex.order.below_min_size',
    });
    await expect(
      orders.prepare(principal, { kind: 'sell_above', side: 'sell', amount: '100', trigger: '1.25', expiryHours: '24' }),
    ).rejects.toMatchObject({
      code: 'dex.order.insufficient_credit',
    });
    chain.setCredit(A, a('100'));
    const [view] = await place(orders, { kind: 'sell_above', side: 'sell', amount: '100', trigger: '1.25', expiryHours: '24' });
    expect(view).toMatchObject({ state: 'open', kindName: 'Sell above', amount: '100', trigger: '1.25', version: 1 });
  });

  it('a take-profit at or under the stop on a sell is refused', async () => {
    const { orders, chain } = world();
    chain.setCredit(A, a('10'));
    await expect(
      orders.prepare(principal, {
        kind: 'take_profit_and_stop',
        side: 'sell',
        amount: '10',
        takeProfit: '0.90',
        stop: '1.10',
        expiryHours: '24',
      }),
    ).rejects.toMatchObject({ code: 'dex.order.tp_not_above_sl' });
  });

  it('a trailing stop takes a distance within the published bounds, never a trigger price', async () => {
    const { orders, chain } = world();
    chain.setCredit(A, a('10'));
    await expect(
      orders.prepare(principal, { kind: 'trailing_stop', side: 'sell', amount: '10', trigger: '0.9', expiryHours: '24' }),
    ).rejects.toMatchObject({
      code: 'dex.order.trigger_not_allowed_on_trailing',
    });
    await expect(
      orders.prepare(principal, { kind: 'trailing_stop', side: 'sell', amount: '10', trailPercent: '50', expiryHours: '24' }),
    ).rejects.toMatchObject({
      code: 'dex.order.trail_out_of_bounds',
    });
    const blank = new WalletOrders(new WalletOrderStore(mkdtempSync(join(tmpdir(), 'dex-vault-'))), chain, {
      ...SETTINGS,
      trailBounds: undefined,
    });
    await expect(
      blank.prepare(principal, { kind: 'trailing_stop', side: 'sell', amount: '10', trailPercent: '5', expiryHours: '24' }),
    ).rejects.toMatchObject({
      code: 'dex.order.trail_bounds_unset',
    });
  });

  it('a signature from another wallet is refused and nothing is stored', async () => {
    const { orders, chain, store } = world();
    chain.setCredit(A, a('10'));
    await expect(
      place(
        orders,
        { kind: 'sell_above', side: 'sell', amount: '10', trigger: '2', expiryHours: '1' },
        '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
      ),
    ).rejects.toMatchObject({ code: 'dex.order.signature_invalid' });
    expect(store.all()).toHaveLength(0);
  });

  it('a blank pair, slippage or restricted list refuses by name', async () => {
    const { chain } = world();
    const mk = (s: Partial<typeof SETTINGS>) =>
      new WalletOrders(new WalletOrderStore(mkdtempSync(join(tmpdir(), 'dex-vault-'))), chain, { ...SETTINGS, ...s } as never);
    const input = { kind: 'sell_above', side: 'sell', amount: '10', trigger: '2', expiryHours: '1' } as const;
    await expect(mk({ pairs: undefined }).prepare(principal, input)).rejects.toMatchObject({ code: 'dex.order.pair_unset' });
    await expect(mk({ slippageBps: undefined }).prepare(principal, input)).rejects.toMatchObject({ code: 'dex.order.slippage_unset' });
    await expect(mk({ restrictedTokens: undefined }).prepare(principal, input)).rejects.toMatchObject({
      code: 'dex.order.restricted_list_unset',
    });
  });
});

describe('the keeper (D-limit-dca-02 to -04)', () => {
  it('fills the largest part the pool pays the minimum for, and leaves the rest open; a stale price logs why', async () => {
    const { orders, chain, keeper, store } = world();
    chain.setCredit(A, a('100'));
    const [v] = await place(orders, { kind: 'sell_above', side: 'sell', amount: '100', trigger: '1.25', expiryHours: '24' });
    await keeper.tick();
    expect(chain.sent).toHaveLength(0);
    expect(store.get(v!.id)!.attempts.at(-1)!.reason).toBe('predicate_false');
    // Price at 1.30; a thin pool pays the floor for 40 only.
    chain.priceWad = 13n * 10n ** 17n;
    const row = store.get(v!.id)!;
    const rIn = a('1000');
    let lo = 1n;
    let hi = 10n ** 30n;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (poolOut(a('40'), rIn, mid, 30n) >= floorFor(row.order, a('40'))) hi = mid;
      else lo = mid;
    }
    chain.reserves = { a: rIn, b: hi };
    await keeper.tick();
    const after = await orders.view(store.get(v!.id)!);
    expect(after).toMatchObject({ state: 'open', filled: '40', open: '60' });
    expect(store.get(v!.id)!.events.at(-1)).toMatchObject({ type: 'fill', label: 'partial' });
    // Every fill paid at least its share of the minimum output.
    const fill = store.get(v!.id)!.events.at(-1)!;
    expect(Number(fill.amountOut)).toBeGreaterThanOrEqual(Number(fill.minOut));
    await keeper.tick();
    expect(store.get(v!.id)!.attempts.at(-1)!.reason).toBe('insufficient_liquidity');
    chain.priceWad = 'stale';
    await keeper.tick();
    expect(store.get(v!.id)!.attempts.at(-1)!.reason).toBe('oracle_stale');
    expect(store.get(v!.id)!.state).toBe('open');
  });

  it('one leg filling in full cancels its sibling by link', async () => {
    const { orders, chain, keeper } = world();
    chain.setCredit(A, a('10'));
    const legs = await place(orders, {
      kind: 'take_profit_and_stop',
      side: 'sell',
      amount: '10',
      takeProfit: '1.40',
      stop: '0.80',
      expiryHours: '24',
    });
    chain.priceWad = 8n * 10n ** 17n;
    chain.reserves = { a: a('1000000'), b: b('800000') };
    await keeper.tick();
    const [tp, sl] = await Promise.all(legs.map(async (l) => (await orders.list(principal, {})).orders.find((o) => o.id === l.id)!));
    expect(sl!.stateName).toBe('Filled');
    expect(tp!.stateName).toBe('Cancelled by link');
  });

  it('a bracket parent buys into the vault and its exits cover what it bought, no more', async () => {
    const { orders, chain, keeper } = world();
    chain.setCredit(B, b('20'));
    chain.priceWad = 8n * 10n ** 17n;
    chain.reserves = { a: a('1000000'), b: b('800000') };
    const rows = await place(orders, {
      kind: 'bracket',
      side: 'buy',
      amount: '20',
      trigger: '0.95',
      takeProfit: '1.10',
      stop: '0.70',
      expiryHours: '24',
    });
    expect(rows.map((r) => r.state)).toEqual(['open', 'waiting', 'waiting']);
    await keeper.tick();
    await keeper.tick();
    const list = (await orders.list(principal, {})).orders;
    const parent = list.find((o) => o.kind === 'bracket')!;
    expect(Number(parent.filled)).toBeGreaterThan(0);
    expect(parent.cover).toBe(parent.filled);
    expect(list.filter((o) => o.parentId === parent.id).map((o) => o.state)).toEqual(['open', 'open']);
  });

  it('a send that times out after the node took it: the fill is found on chain and recorded once, never bought twice', async () => {
    const { orders, chain, keeper } = world();
    chain.setCredit(B, b('20'));
    chain.priceWad = 8n * 10n ** 17n;
    chain.reserves = { a: a('1000000'), b: b('800000') };
    const [row] = await place(orders, { kind: 'buy_below', side: 'buy', amount: '10', trigger: '0.95', expiryHours: '24' });
    chain.throwAfterSend = true;
    await keeper.tick();
    expect(chain.sent).toHaveLength(1);
    await keeper.tick();
    await keeper.tick();
    const view = (await orders.list(principal, {})).orders.find((o) => o.id === row!.id)!;
    expect(chain.sent).toHaveLength(1);
    expect(view.state).toBe('Filled');
    expect(Number(view.filled)).toBeGreaterThanOrEqual(10);
  });

  it('a trailing stop: the watermark follows the price up and never down', async () => {
    const { orders, chain, keeper } = world();
    chain.setCredit(A, a('10'));
    chain.priceWad = 8n * 10n ** 17n;
    const [t] = await place(orders, { kind: 'trailing_stop', side: 'sell', amount: '10', trailPercent: '5', expiryHours: '24' });
    const trig = async () => Number((await orders.list(principal, {})).orders.find((o) => o.id === t!.id)!.trigger);
    await keeper.tick();
    const first = await trig();
    chain.priceWad = 88n * 10n ** 16n;
    await keeper.tick();
    const up = await trig();
    chain.priceWad = 85n * 10n ** 16n;
    await keeper.tick();
    const down = await trig();
    expect(up).toBeGreaterThan(first);
    expect(down).toBe(up);
  });

  it('a cancel refuses the keeper by the stored state, and nothing is sent', async () => {
    const { orders, chain, keeper, store } = world();
    chain.setCredit(A, a('10'));
    const [v] = await place(orders, { kind: 'sell_above', side: 'sell', amount: '10', trigger: '0.5', expiryHours: '24' });
    const cancelled = await orders.cancel(principal, v!.id);
    expect(cancelled.order.state).toBe('cancelled');
    expect(cancelled.calls).toHaveLength(1);
    await keeper.tick();
    expect(chain.sent).toHaveLength(0);
    expect(store.get(v!.id)!.events.map((e) => e.type)).toContain('cancel_refused_fill');
    await expect(orders.cancel(principal, v!.id)).rejects.toMatchObject({ code: 'dex.order.not_cancellable' });
  });

  it('an edit raises the version and the keeper checks the new trigger; a filled order is not editable', async () => {
    const { orders, chain, keeper, store } = world();
    chain.setCredit(A, a('10'));
    const [v] = await place(orders, { kind: 'sell_above', side: 'sell', amount: '10', trigger: '1.25', expiryHours: '24' });
    await keeper.tick();
    const prepared = await orders.prepareEdit(principal, v!.id, { trigger: '1.30' });
    expect(prepared.replaceOnChain).toBe(false);
    const { EIP712Domain: _d, ...types } = prepared.typedData.types;
    const sig = await maker.signTypedData({
      domain: prepared.typedData.domain,
      types,
      primaryType: 'Order',
      message: prepared.typedData.message,
    } as never);
    const edited = await orders.update(principal, prepared.draftId, sig);
    expect(edited).toMatchObject({ version: 2, trigger: '1.30' });
    await keeper.tick();
    expect(store.get(v!.id)!.attempts.find((x) => x.reason === 'checked' && x.version === 2)).toMatchObject({ trigger: '1.30' });
    chain.priceWad = 2n * WAD;
    chain.reserves = { a: a('1000000'), b: b('2000000') };
    await keeper.tick();
    expect(store.get(v!.id)!.state).toBe('filled');
    await expect(orders.prepareEdit(principal, v!.id, { trigger: '1.5' })).rejects.toMatchObject({ code: 'dex.order.not_editable' });
  });

  it('an order past its expiry is expired, and another wallet cannot read it', async () => {
    const { orders, chain, keeper } = world();
    chain.setCredit(A, a('10'));
    const [v] = await place(orders, { kind: 'sell_above', side: 'sell', amount: '10', trigger: '2', expiryHours: '0.005' });
    chain.time += 60n;
    await keeper.tick();
    expect((await orders.list(principal, { state: 'expired' })).orders.map((o) => o.id)).toEqual([v!.id]);
    expect(() => orders.history({ ...principal, wallet: '0x0000000000000000000000000000000000000001' }, v!.id)).toThrow(
      expect.objectContaining({ code: 'dex.order.not_found' }),
    );
  });

  it('a send whose process died before the hash was stored is cleared on the next pass, and the same round key is reused', async () => {
    const { orders, chain, keeper, store } = world();
    chain.setCredit(A, a('10'));
    const [v] = await place(orders, { kind: 'sell_above', side: 'sell', amount: '10', trigger: '0.5', expiryHours: '24' });
    const row = store.get(v!.id)!;
    row.pending = { key: `dex.order.fill:${row.id}:1`, round: 1, take: a('10'), txHash: null };
    row.state = 'executing';
    await keeper.tick();
    expect(store.get(v!.id)!.pending).toBeNull();
    await keeper.tick();
    expect(store.get(v!.id)!.state).toBe('filled');
    expect(store.get(v!.id)!.round).toBe(1);
  });

  it('lists page at 100 and filter by state', async () => {
    const { orders, chain } = world();
    chain.setCredit(A, a('100'));
    await place(orders, { kind: 'sell_above', side: 'sell', amount: '1', trigger: '3', expiryHours: '1' });
    const page = await orders.list(principal, { state: 'open' });
    expect(page.pageSize).toBe(100);
    expect(page.orders.every((o) => o.state === 'open')).toBe(true);
  });
});
