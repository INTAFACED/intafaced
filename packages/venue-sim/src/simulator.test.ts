import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  refuseTestVenueOutsideTest,
  type ApproveAgentIntent,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import { defineUserVenueConformance, type ConformanceWallet } from './conformance.js';
import { buildTypedData, digestOf, type TestVenueTypedData } from './signing.js';

const a = parseAmount;

/** A TEST wallet with a fixed key derived from its name, so every run signs the same bytes. */
function testWallet(name: string, role: 'owner' | 'agent' = 'owner'): ConformanceWallet & { address: string } {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role, address },
    async sign(prepared: PreparedVenueAction) {
      const typed = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

const SPOT: SimMarketConfig = {
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC', 'ALO'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1') },
  takerFeeBps: { known: true, value: a('3.5') },
};

const PERP: SimMarketConfig = {
  symbol: 'BTC-PERP',
  kind: 'perpetual',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: ['isolated'],
  maxLeverageBps: 200_000,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1.5') },
  takerFeeBps: { known: true, value: a('4.5') },
  maintenanceMarginRate: a('0.005'),
  markPrice: a('60000'),
};

function world() {
  let now = Date.UTC(2026, 10, 8, 12, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [SPOT, PERP] });
  const wallet = testWallet('trader');
  const agent = testWallet('trader-agent', 'agent');
  const otherWallet = testWallet('maker');
  const trader: UserVenueAccount = { venueId: sim.venue.id, owner: wallet.address, subAccount: null };
  const other: UserVenueAccount = { venueId: sim.venue.id, owner: otherWallet.address, subAccount: null };
  const run = async (who: ConformanceWallet, account: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(account, who.signer, intent);
    const outcome = await sim.submit(prepared, await who.sign(prepared));
    now += 1000;
    return { prepared, outcome };
  };
  return { sim, wallet, agent, otherWallet, trader, other, run, tick: () => (now += 1000) };
}

function order(
  symbol: string,
  side: 'buy' | 'sell',
  price: string,
  amount: string,
  key: string,
  extra: Partial<PlaceUserOrderIntent> = {},
): PlaceUserOrderIntent {
  return {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount: a(amount),
    price: a(price),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
    ...extra,
  };
}

function balanceOf(list: readonly { asset: string; free: Amount; locked: Amount; total: Amount }[], asset: string) {
  return list.find((b) => b.asset === asset) ?? { asset, free: ZERO, locked: ZERO, total: ZERO };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    return (error as VenueRefusalError).refusal.code;
  }
  throw new Error('expected a refusal');
}

defineUserVenueConformance(
  {
    canLoseAnswers: true,
    dedupesClientIds: true,
    canSettleWithdrawals: true,
    perp: { symbol: 'BTC-PERP', quote: 'USDC', price: a('60000'), closePrice: a('61000'), size: a('0.1'), leverageBps: 100_000 },
    async setup() {
      const w = world();
      return {
        venue: w.sim,
        trader: { account: w.trader, wallet: w.wallet, agent: w.agent },
        other: { account: w.other, wallet: w.otherWallet },
        third: (() => {
          const wallet = testWallet('third');
          return { account: { venueId: w.sim.venue.id, owner: wallet.address, subAccount: null }, wallet };
        })(),
        spot: { symbol: 'BTC-USDC', base: 'BTC', quote: 'USDC', price: a('60000'), size: a('0.01') },
        async fund(account, asset, amount, ref) {
          w.sim.deposit(account, asset, amount, ref);
        },
        loseNextAnswer: () => {
          w.sim.switches.loseAnswers = 1;
        },
        settleWithdrawals: () => {
          w.sim.settleWithdrawals();
        },
        setVenueDown: (down) => {
          w.sim.switches.venueDown = down;
        },
      };
    },
  },
  { describe, it, expect: expect as never },
);

describe('TEST venue simulator: J-cex-spot-01 at the venue', () => {
  it('#4 a deposit shows free 1,000 and used 0, and a replayed deposit event adds nothing', async () => {
    const w = world();
    expect(w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:0xabc:0')).toBe(true);
    expect(w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:0xabc:0')).toBe(false);
    const b = balanceOf((await w.sim.balances(w.trader)).value, 'USDC');
    expect(b).toEqual({ asset: 'USDC', free: a('1000'), locked: ZERO, total: a('1000') });
  });

  it('#7–#8 a limit buy rests with the venue lock, then a TEST sell fills it as maker with both fee lines', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:1');
    w.sim.deposit(w.other, 'BTC', a('1'), 'chain:o:1');
    await w.run(w.wallet, w.trader, { kind: 'approve_builder_fee', builder: '0xb11de4', maxFeeBps: a('1') });
    const buy = order('BTC-USDC', 'buy', '60000', '0.1', 'order:trader:desk:7', { builderFee: { builder: '0xb11de4', feeBps: a('0.5') } });
    const placed = await w.run(w.wallet, w.trader, buy);
    expect(placed.prepared.builderFee).toEqual({ builder: '0xb11de4', feeBps: a('0.5') });
    const open = (await w.sim.openOrders(w.trader)).value;
    expect(open.map((o) => [o.status, o.locked])).toEqual([['open', a('6000')]]);
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('94000'), locked: a('6000') });

    await w.run(w.otherWallet, w.other, order('BTC-USDC', 'sell', '60000', '0.1', 'order:maker:desk:8'));
    const fill = (await w.sim.fills(w.trader, new Date(0))).value[0]!;
    // A spot buy pays in the BTC it receives: maker 1 bps of 0.1 BTC = 0.00001; builder 0.5 bps = 0.000005.
    expect([fill.role, fill.price, fill.amount, fill.venueFee, fill.builderFee, fill.feeAsset]).toEqual([
      'maker',
      a('60000'),
      a('0.1'),
      a('0.00001'),
      a('0.000005'),
      'BTC',
    ]);
    const balances = (await w.sim.balances(w.trader)).value;
    expect(balanceOf(balances, 'USDC')).toMatchObject({ free: a('94000'), locked: ZERO });
    expect(balanceOf(balances, 'BTC').free).toBe(sub(a('0.1'), a('0.000015')));
    expect((await w.sim.orderByClientId(w.trader, placed.prepared.venueClientOrderId!)).value?.status).toBe('filled');
  });

  it('#6 an order carrying more builder fee than the account approved is refused before signing', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:6');
    expect(
      await refusal(
        w.sim.prepare(
          w.trader,
          w.wallet.signer,
          order('BTC-USDC', 'buy', '60000', '0.1', 'order:t:6', { builderFee: { builder: '0xb11de4', feeBps: a('0.5') } }),
        ),
      ),
    ).toBe('builder_fee_not_approved');
  });

  it('#9 a market buy fills inside its slippage limit and leaves nothing locked', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:9');
    w.sim.deposit(w.other, 'BTC', a('1'), 'chain:o:9');
    await w.run(w.otherWallet, w.other, order('BTC-USDC', 'sell', '60000', '0.05', 'order:maker:9'));
    const { outcome } = await w.run(
      w.wallet,
      w.trader,
      order('BTC-USDC', 'buy', '60100', '0.1', 'order:t:9', { type: 'market', timeInForce: 'IOC' }),
    );
    expect(outcome.definite && outcome.accepted && [outcome.order?.status, outcome.order?.filled]).toEqual(['canceled', a('0.05')]);
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('97000'), locked: ZERO });
    expect((await w.sim.openOrders(w.trader)).value).toEqual([]);
  });

  it('#12 an owner withdrawal shows pending then done, with its fee or "not known"', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:12');
    const { prepared, outcome } = await w.run(w.wallet, w.trader, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: w.wallet.address,
      withdrawalKey: 'withdraw:t:12',
    });
    expect(outcome.definite && outcome.accepted).toBe(true);
    expect((await w.sim.withdrawal(w.trader, prepared.nonce)).value).toMatchObject({
      status: 'pending',
      fee: { known: true, value: a('1') },
    });
    expect(w.sim.settleWithdrawals()).toBe(1);
    expect((await w.sim.withdrawal(w.trader, prepared.nonce)).value?.status).toBe('done');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('989'));

    w.sim.switches.withdrawalFee = { known: false };
    const second = await w.run(w.wallet, w.trader, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: w.wallet.address,
      withdrawalKey: 'withdraw:t:12b',
    });
    expect((await w.sim.withdrawal(w.trader, second.prepared.nonce)).value?.fee).toEqual({ known: false });
  });

  it('a withdrawal from a sub-account is refused before signing', async () => {
    const w = world();
    const sub = { ...w.trader, subAccount: 'agent-1' };
    w.sim.deposit(sub, 'USDC', a('100'), 'chain:t:sub');
    expect(
      await refusal(
        w.sim.prepare(sub, w.wallet.signer, {
          kind: 'withdraw',
          asset: 'USDC',
          amount: a('10'),
          destination: w.wallet.address,
          withdrawalKey: 'withdraw:t:sub',
        }),
      ),
    ).toBe('not_offered');
  });

  it('a lost withdrawal answer is re-sent as the same signed bytes and withdraws once', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:13');
    const prepared = await w.sim.prepare(w.trader, w.wallet.signer, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: w.wallet.address,
      withdrawalKey: 'withdraw:t:13',
    });
    const signature = await w.wallet.sign(prepared);
    w.sim.switches.loseAnswers = 1;
    expect((await w.sim.submit(prepared, signature)).definite).toBe(false);
    const again = await w.sim.submit(prepared, signature);
    expect(again.definite && again.accepted).toBe(true);
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('989'));
  });
});

describe('TEST venue simulator: J-derivatives-01 at the venue', () => {
  const perpOrder = (side: 'buy' | 'sell', price: string, size: string, key: string, extra: Partial<PlaceUserOrderIntent> = {}) =>
    order('BTC-PERP', side, price, size, key, extra);
  const tenX = { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' } as const;

  it('#5 a margin mode the venue does not offer is refused, and nothing changes', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:d5');
    expect(await refusal(w.sim.prepare(w.trader, w.wallet.signer, { ...tenX, marginMode: 'cross' }))).toBe('not_offered');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('1000'), locked: ZERO });
  });

  it('#6 a perp order before any leverage is set is refused leverage_not_set, before signing', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:d6');
    expect(await refusal(w.sim.prepare(w.trader, w.wallet.signer, perpOrder('buy', '60000', '0.01', 'order:t:d6')))).toBe(
      'leverage_not_set',
    );
    expect(await refusal(w.sim.prepare(w.trader, w.wallet.signer, { ...tenX, leverageBps: 250_000 }))).toBe('not_offered');
    expect(await refusal(w.sim.prepare(w.trader, w.wallet.signer, { ...tenX, leverageBps: 105_000 }))).toBe('not_offered');
    expect((await w.sim.leverage(w.trader, 'BTC-PERP')).value).toBeNull();
    await w.run(w.wallet, w.trader, tenX);
    expect((await w.sim.leverage(w.trader, 'BTC-PERP')).value).toEqual({
      symbol: 'BTC-PERP',
      leverageBps: 100_000,
      marginMode: 'isolated',
    });
  });

  it('#7 a time in force the venue does not offer is refused with no network write', async () => {
    const w = world();
    expect(
      await refusal(w.sim.prepare(w.trader, w.wallet.signer, perpOrder('buy', '60000', '0.01', 'order:t:d7', { timeInForce: 'ALO' }))),
    ).toBe('not_offered');
  });

  it('#8–#10 opens one isolated long, reports it as the venue does, closes 40 percent then the rest', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:d8');
    w.sim.deposit(w.other, 'USDC', a('100000'), 'chain:o:d8');
    await w.run(w.wallet, w.trader, tenX);
    await w.run(w.otherWallet, w.other, tenX);
    await w.run(w.otherWallet, w.other, perpOrder('sell', '60000', '0.1', 'order:maker:d8'));
    // A double press: the same intent twice is one order.
    const open = perpOrder('buy', '60000', '0.1', 'order:t:d8:open');
    await w.run(w.wallet, w.trader, open);
    await w.run(w.wallet, w.trader, open);
    let positions = (await w.sim.positions(w.trader)).value;
    expect(positions.map((p) => [p.side, p.size, p.entryPrice, p.margin, p.leverageBps, p.marginMode])).toEqual([
      ['long', a('0.1'), a('60000'), a('600'), 100_000, 'isolated'],
    ]);
    // Liquidation: 60000 − (600 − 0.5% × 6000) / 0.1 = 54300.
    expect(positions[0]!.liquidationPrice).toEqual({ known: true, value: a('54300') });
    // Taker 4.5 bps of 6,000 = 2.7.
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({
      free: a('397.3'),
      locked: a('600'),
      total: a('997.3'),
    });

    w.sim.setMark('BTC-PERP', a('61000'));
    positions = (await w.sim.positions(w.trader)).value;
    expect(positions[0]!.unrealisedPnl).toBe(a('100'));

    // A second TEST trader, flat, rests the bid the closes sell into.
    const bidder = testWallet('bidder');
    const bidderAccount = { venueId: w.sim.venue.id, owner: bidder.address, subAccount: null };
    w.sim.deposit(bidderAccount, 'USDC', a('100000'), 'chain:b:d10');
    await w.run(bidder, bidderAccount, tenX);
    await w.run(bidder, bidderAccount, perpOrder('buy', '61000', '0.1', 'order:bidder:d10'));
    const close40 = perpOrder('sell', '61000', '0.04', 'order:t:d10:close1', { reduceOnly: true, timeInForce: 'IOC' });
    await w.run(w.wallet, w.trader, close40);
    await w.run(w.wallet, w.trader, close40); // the repeated close id is answered once
    await w.run(w.wallet, w.trader, perpOrder('sell', '61000', '0.06', 'order:t:d10:close2', { reduceOnly: true, timeInForce: 'IOC' }));
    expect((await w.sim.positions(w.trader)).value).toEqual([]);
    const closes = (await w.sim.fills(w.trader, new Date(0))).value.filter((f) => f.realisedPnl !== null);
    expect(closes.map((f) => f.realisedPnl)).toEqual([a('40'), a('60')]);
    // 397.3 + margin 600 + result 100 − taker fees at 4.5 bps on the closes (2,440 → 1.098; 3,660 → 1.647) = 1094.555
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('1094.555'), locked: ZERO });
  });
});

describe('TEST venue simulator: switches and labels', () => {
  it('is a TEST venue, refused outside APP_ENV dev or test', () => {
    const w = world();
    expect(w.sim.venue.proofLevel).toBe('simulator');
    expect(() => refuseTestVenueOutsideTest(w.sim.venue, 'test')).not.toThrow();
    expect(() => refuseTestVenueOutsideTest(w.sim.venue, 'prod')).toThrow(VenueRefusalError);
  });

  it('venue down refuses every call and changes nothing', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:down');
    w.sim.switches.venueDown = true;
    expect(await refusal(w.sim.markets(null))).toBe('venue_down');
    expect(await refusal(w.sim.balances(w.trader))).toBe('venue_down');
    expect(await refusal(w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '60000', '0.01', 'order:t:down')))).toBe(
      'venue_down',
    );
    w.sim.switches.venueDown = false;
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('1000'));
  });

  it('an unpublished fee is reported as not known, never as 0', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(0), markets: [{ ...SPOT, takerFeeBps: { known: false } }] });
    expect((await sim.markets(null)).value[0]!.takerFeeBps).toEqual({ known: false });
  });

  it('an order type the market does not offer is refused before signing', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(0), markets: [{ ...SPOT, orderTypes: ['limit'] }] });
    const w = testWallet('x');
    const account = { venueId: sim.venue.id, owner: w.address, subAccount: null };
    expect(
      await refusal(
        sim.prepare(account, w.signer, order('BTC-USDC', 'buy', '60000', '0.01', 'order:x:1', { type: 'market', timeInForce: 'IOC' })),
      ),
    ).toBe('not_offered');
  });

  it('an agent the owner never approved, or revoked, is refused', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:ag');
    const intent = order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:ag');
    expect(await refusal(w.sim.prepare(w.trader, w.agent.signer, intent))).toBe('signer_not_authorised');
    await w.run(w.wallet, w.trader, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'TEST bot', validUntil: null });
    await w.run(w.agent, w.trader, intent);
    await w.run(w.wallet, w.trader, { kind: 'revoke_agent', agentAddress: w.agent.address });
    expect(await refusal(w.sim.prepare(w.trader, w.agent.signer, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:ag2')))).toBe(
      'signer_not_authorised',
    );
  });

  it('a prepared action edited after signing is refused', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:edit');
    const prepared = await w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:edit'));
    const signature = await w.wallet.sign(prepared);
    const edited = { ...prepared, intent: { ...(prepared.intent as PlaceUserOrderIntent), amount: a('1') } };
    expect(await refusal(w.sim.submit(edited, signature))).toBe('signature_mismatch');
    expect((await w.sim.openOrders(w.trader)).value).toEqual([]);
  });

  it('a post-only order that would take is refused, and the lock is untouched', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:alo');
    w.sim.deposit(w.other, 'BTC', a('1'), 'chain:o:alo');
    await w.run(w.otherWallet, w.other, order('BTC-USDC', 'sell', '60000', '0.1', 'order:maker:alo'));
    const { outcome } = await w.run(w.wallet, w.trader, order('BTC-USDC', 'buy', '60000', '0.1', 'order:t:alo', { timeInForce: 'ALO' }));
    expect(outcome.definite && !outcome.accepted && outcome.refusal.code).toBe('venue_rejected');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('100000'), locked: ZERO });
  });

  it('total always equals free plus locked across a busy run', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:inv');
    w.sim.deposit(w.other, 'BTC', a('1'), 'chain:o:inv');
    for (let i = 0; i < 5; i++) {
      await w.run(w.otherWallet, w.other, order('BTC-USDC', 'sell', String(60000 + i), '0.01', `order:maker:inv:${i}`));
      await w.run(w.wallet, w.trader, order('BTC-USDC', 'buy', String(59990 - i), '0.01', `order:t:inv:${i}`));
    }
    await w.run(w.wallet, w.trader, order('BTC-USDC', 'buy', '60010', '0.03', 'order:t:inv:x', { type: 'market', timeInForce: 'IOC' }));
    for (const who of [w.trader, w.other]) {
      for (const b of (await w.sim.balances(who)).value) expect(b.total).toBe(add(b.free, b.locked));
      const lockedByOrders = (await w.sim.openOrders(who)).value.reduce((s, o) => add(s, o.lockedAsset === 'USDC' ? o.locked : ZERO), ZERO);
      expect(balanceOf((await w.sim.balances(who)).value, 'USDC').locked).toBe(lockedByOrders);
    }
  });
});

describe('TEST venue simulator: review regressions', () => {
  const perp = (side: 'buy' | 'sell', price: string, size: string, key: string, extra: Partial<PlaceUserOrderIntent> = {}) =>
    order('BTC-PERP', side, price, size, key, extra);
  const tenX = { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' } as const;

  it('recovers the signer over the typed data it rebuilt, not the client copy', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:r1');
    const big = await w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '50000', '1', 'order:t:r1'));
    const small = await w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '50000', '0.001', 'order:t:r1b'));
    const signedSmall = await w.wallet.sign(small);
    expect(await refusal(w.sim.submit({ ...big, typedData: small.typedData, digest: small.digest }, signedSmall))).toBe(
      'signature_mismatch',
    );
    // The wallet was shown (and signed) the small payload; the claim names the big digest, and the intent is big.
    expect(await refusal(w.sim.submit({ ...big, typedData: small.typedData }, { ...signedSmall, digest: big.digest }))).toBe(
      'signature_mismatch',
    );
    expect((await w.sim.openOrders(w.trader)).value).toEqual([]);
  });

  it('an agent revoked between prepare and submit is refused at submit', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:r10');
    await w.run(w.wallet, w.trader, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'TEST bot', validUntil: null });
    const prepared = await w.sim.prepare(w.trader, w.agent.signer, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:r10'));
    await w.run(w.wallet, w.trader, { kind: 'revoke_agent', agentAddress: w.agent.address });
    const outcome = await w.sim.submit(prepared, await w.agent.sign(prepared));
    expect(outcome.definite && !outcome.accepted && outcome.refusal.code).toBe('signer_not_authorised');
    expect((await w.sim.openOrders(w.trader)).value).toEqual([]);
  });

  it('an agent past its validUntil is refused', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:r10b');
    await w.run(w.wallet, w.trader, {
      kind: 'approve_agent',
      agentAddress: w.agent.address,
      agentName: 'TEST bot',
      validUntil: new Date(Date.UTC(2026, 10, 8, 12, 0, 5)),
    });
    for (let i = 0; i < 10; i++) w.tick();
    expect(await refusal(w.sim.prepare(w.trader, w.agent.signer, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:r10b')))).toBe(
      'signer_not_authorised',
    );
  });

  it('a cross with this account own resting order cancels the resting one instead of crossing the book', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:r9');
    w.sim.deposit(w.trader, 'BTC', a('1'), 'chain:t:r9b');
    const sell = await w.run(w.wallet, w.trader, order('BTC-USDC', 'sell', '60000', '0.01', 'order:t:r9s'));
    await w.run(w.wallet, w.trader, order('BTC-USDC', 'buy', '60100', '0.01', 'order:t:r9b'));
    expect((await w.sim.orderByClientId(w.trader, sell.prepared.venueClientOrderId!)).value?.status).toBe('canceled');
    expect((await w.sim.fills(w.trader, new Date(0))).value).toEqual([]);
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'BTC')).toMatchObject({ free: a('1'), locked: ZERO });
  });

  it('an isolated loss stops at the margin released', async () => {
    const w = world();
    const bidder = testWallet('bidder-loss');
    const bidderAccount = { venueId: w.sim.venue.id, owner: bidder.address, subAccount: null };
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:r6');
    w.sim.deposit(w.other, 'USDC', a('100000'), 'chain:o:r6');
    w.sim.deposit(bidderAccount, 'USDC', a('100000'), 'chain:b:r6');
    for (const [who, acct] of [
      [w.wallet, w.trader],
      [w.otherWallet, w.other],
      [bidder, bidderAccount],
    ] as const)
      await w.run(who, acct, tenX);
    await w.run(w.otherWallet, w.other, perp('sell', '60000', '0.1', 'order:o:r6'));
    await w.run(w.wallet, w.trader, perp('buy', '60000', '0.1', 'order:t:r6'));
    const freeOpen = balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free;
    await w.run(bidder, bidderAccount, perp('buy', '50000', '0.1', 'order:b:r6'));
    await w.run(w.wallet, w.trader, perp('sell', '50000', '0.1', 'order:t:r6c', { reduceOnly: true, timeInForce: 'IOC' }));
    const close = (await w.sim.fills(w.trader, new Date(0))).value.find((f) => f.realisedPnl !== null)!;
    expect(close.realisedPnl).toBe(a('-600'));
    // The margin (600) is gone and no more: free drops only by the close's taker fee (4.5 bps of 5,000 = 2.25).
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: sub(freeOpen, a('2.25')), locked: ZERO });
  });

  it('perp margin is posted at the fill price, and the lock covers the fees', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('602.7'), 'chain:t:r7');
    w.sim.deposit(w.other, 'USDC', a('100000'), 'chain:o:r7');
    await w.run(w.wallet, w.trader, tenX);
    await w.run(w.otherWallet, w.other, tenX);
    await w.run(w.otherWallet, w.other, perp('sell', '59000', '0.1', 'order:o:r7'));
    await w.run(w.wallet, w.trader, perp('buy', '60000', '0.1', 'order:t:r7', { type: 'market', timeInForce: 'IOC' }));
    const position = (await w.sim.positions(w.trader)).value[0]!;
    expect(position.margin).toBe(a('590'));
    // 602.7 locked; 590 margin and 2.655 taker fee taken; 10.045 back to free. Free never goes below zero.
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({
      free: a('10.045'),
      locked: a('590'),
      total: a('600.045'),
    });
  });

  it('a reduce-only close larger than the position, or a resting one, is refused', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:r5');
    w.sim.deposit(w.other, 'USDC', a('100000'), 'chain:o:r5');
    await w.run(w.wallet, w.trader, tenX);
    await w.run(w.otherWallet, w.other, tenX);
    await w.run(w.otherWallet, w.other, perp('sell', '60000', '0.1', 'order:o:r5'));
    await w.run(w.wallet, w.trader, perp('buy', '60000', '0.1', 'order:t:r5'));
    const tooBig = await w.run(w.wallet, w.trader, perp('sell', '60000', '0.2', 'order:t:r5c', { reduceOnly: true, timeInForce: 'IOC' }));
    expect(tooBig.outcome.definite && !tooBig.outcome.accepted && tooBig.outcome.refusal.code).toBe('venue_rejected');
    expect(await refusal(w.sim.prepare(w.trader, w.wallet.signer, perp('sell', '61000', '0.1', 'order:t:r5r', { reduceOnly: true })))).toBe(
      'not_offered',
    );
    const flip = await w.run(w.wallet, w.trader, perp('sell', '60000', '0.2', 'order:t:r5f'));
    expect(flip.outcome.definite && !flip.outcome.accepted && flip.outcome.refusal.code).toBe('not_offered');
    expect((await w.sim.positions(w.trader)).value.map((p) => [p.side, p.size])).toEqual([['long', a('0.1')]]);
  });

  it('nonces keep rising when the clock stands still', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(0), markets: [SPOT] });
    const w = testWallet('frozen');
    const account = { venueId: sim.venue.id, owner: w.address, subAccount: null };
    const seen = new Set<string>();
    for (let i = 0; i < 1200; i++)
      seen.add((await sim.prepare(account, w.signer, order('BTC-USDC', 'buy', '1', '0.001', `order:f:${i}`))).nonce);
    expect(seen.size).toBe(1200);
  });
});

describe('TEST venue simulator: council round 1 regressions', () => {
  const outcomeCode = async (p: Promise<{ definite: boolean } & Record<string, unknown>>) => {
    try {
      const r = (await p) as { definite: boolean; accepted?: boolean; refusal?: { code: string } };
      return r.definite ? (r.accepted ? 'accepted' : `refused:${r.refusal!.code}`) : 'not-definite';
    } catch (error) {
      return `threw:${(error as VenueRefusalError).refusal?.code ?? (error as Error).message}`;
    }
  };

  it('P1 a negative withdrawal is refused and creates nothing', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100'), 'chain:t:p1');
    const intent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('-1000'),
      destination: w.wallet.address,
      withdrawalKey: 'withdraw:t:p1',
    } as const;
    expect(await refusal(w.sim.prepare(w.trader, w.wallet.signer, intent))).toBe('venue_rejected');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('100'));
  });

  it('P2 a key claiming the owner role on someone else account is refused at submit', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:p2');
    const attacker = w.otherWallet;
    const p = await w.sim.prepare(w.other, attacker.signer, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('500'),
      destination: attacker.address,
      withdrawalKey: 'withdraw:x:p2',
    });
    const td = buildTypedData(w.sim.venue.id, w.trader, attacker.signer, p.intent, p.nonce);
    const forged = { ...p, account: w.trader, typedData: td, digest: digestOf(td) };
    expect(await outcomeCode(w.sim.submit(forged, await attacker.sign(forged)))).toBe('refused:signer_not_authorised');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('1000'));
  });

  it('P3 an approved agent that rewrites a cancel into a withdrawal is refused at submit', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:p3');
    await w.run(w.wallet, w.trader, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'TEST bot', validUntil: null });
    const p = await w.sim.prepare(w.trader, w.agent.signer, { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'order:x:p3' });
    const intent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('900'),
      destination: w.agent.address,
      withdrawalKey: 'withdraw:a:p3',
    } as const;
    const td = buildTypedData(w.sim.venue.id, w.trader, w.agent.signer, intent, p.nonce);
    const forged = { ...p, intent, venueClientOrderId: null, typedData: td, digest: digestOf(td) };
    expect(await outcomeCode(w.sim.submit(forged, await w.agent.sign(forged)))).toBe('refused:agent_not_permitted');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('1000'));
  });

  it('P4 an agent expiry is signed: changing it after signing is refused', async () => {
    const w = world();
    const p = await w.sim.prepare(w.trader, w.wallet.signer, {
      kind: 'approve_agent',
      agentAddress: w.agent.address,
      agentName: 'TEST bot',
      validUntil: new Date(Date.UTC(2026, 10, 9)),
    });
    expect((p.typedData as TestVenueTypedData).message.payload).toContain('2026-11-09T00:00:00.000Z');
    const signature = await w.wallet.sign(p);
    const edited = { ...p, intent: { ...(p.intent as ApproveAgentIntent), validUntil: new Date(Date.UTC(2100, 0, 1)) } };
    expect(await refusal(w.sim.submit(edited, signature))).toBe('signature_mismatch');
    expect((await w.sim.agents(w.trader)).value).toEqual([]);
  });

  it('P5 the client order id comes from the signed intent: a swapped id cancels the signed order, not another', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:p5');
    const A = await w.run(w.wallet, w.trader, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:p5a'));
    const B = await w.run(w.wallet, w.trader, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:p5b'));
    const p = await w.sim.prepare(w.trader, w.wallet.signer, { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'order:t:p5a' });
    await w.sim.submit({ ...p, venueClientOrderId: B.prepared.venueClientOrderId }, await w.wallet.sign(p));
    expect((await w.sim.openOrders(w.trader)).value.map((o) => o.venueClientOrderId)).toEqual([B.prepared.venueClientOrderId]);
    expect(A.prepared.venueClientOrderId).not.toBe(B.prepared.venueClientOrderId);
  });

  it('P5b the builder fee comes from the signed intent: dropping it from the prepared object changes nothing', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:p5c');
    w.sim.deposit(w.other, 'BTC', a('1'), 'chain:o:p5c');
    await w.run(w.wallet, w.trader, { kind: 'approve_builder_fee', builder: '0xb11de4', maxFeeBps: a('1') });
    await w.run(w.otherWallet, w.other, order('BTC-USDC', 'sell', '60000', '0.01', 'order:o:p5c'));
    const p = await w.sim.prepare(
      w.trader,
      w.wallet.signer,
      order('BTC-USDC', 'buy', '60000', '0.01', 'order:t:p5c', { builderFee: { builder: '0xb11de4', feeBps: a('1') } }),
    );
    await w.sim.submit({ ...p, builderFee: null }, await w.wallet.sign(p));
    expect((await w.sim.fills(w.trader, new Date(0))).value[0]!.builderFee).toBe(a('0.000001'));
  });

  it('P6 a negative builder fee is refused, on the order and on the approval', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:p6');
    expect(
      await refusal(
        w.sim.prepare(
          w.trader,
          w.wallet.signer,
          order('BTC-USDC', 'buy', '60000', '0.01', 'order:t:p6', { builderFee: { builder: '0xb', feeBps: a('-5000') } }),
        ),
      ),
    ).toBe('venue_rejected');
    expect(
      await refusal(w.sim.prepare(w.trader, w.wallet.signer, { kind: 'approve_builder_fee', builder: '0xb', maxFeeBps: a('-1') })),
    ).toBe('venue_rejected');
  });

  it('P8 a refused order never cancels this account own resting order', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'BTC', a('1'), 'chain:t:p8');
    w.sim.deposit(w.trader, 'USDC', a('100'), 'chain:t:p8u');
    await w.run(w.wallet, w.trader, order('BTC-USDC', 'sell', '60000', '0.01', 'order:t:p8s'));
    const r = await w.run(w.wallet, w.trader, order('BTC-USDC', 'buy', '60000', '0.01', 'order:t:p8b'));
    expect(r.outcome.definite && !r.outcome.accepted && r.outcome.refusal.code).toBe('insufficient_balance');
    expect((await w.sim.openOrders(w.trader)).value.length).toBe(1);
  });

  it('P9 an unpublished trading fee is still charged and reported on the fill, while the market says not known', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(0), markets: [{ ...SPOT, takerFeeBps: { known: false } }] });
    const buyer = testWallet('p9-buyer');
    const seller = testWallet('p9-seller');
    const b = { venueId: sim.venue.id, owner: buyer.address, subAccount: null };
    const s2 = { venueId: sim.venue.id, owner: seller.address, subAccount: null };
    sim.deposit(b, 'USDC', a('100000'), 'chain:b:p9');
    sim.deposit(s2, 'BTC', a('1'), 'chain:s:p9');
    for (const [who, acct, intent] of [
      [seller, s2, order('BTC-USDC', 'sell', '60000', '0.01', 'order:s:p9')],
      [buyer, b, order('BTC-USDC', 'buy', '60000', '0.01', 'order:b:p9')],
    ] as const) {
      const p = await sim.prepare(acct, who.signer, intent);
      await sim.submit(p, await who.sign(p));
    }
    expect((await sim.markets(null)).value[0]!.takerFeeBps).toEqual({ known: false });
    // The hidden taker fee is 5 bps of 0.01 BTC.
    expect((await sim.fills(b, new Date(0))).value[0]!.venueFee).toBe(a('0.000005'));
  });

  it('a reused nonce on a different action is answered not definite, never a definite refusal', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:nonce');
    const first = await w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:n1'));
    await w.sim.submit(first, await w.wallet.sign(first));
    const second = await w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:n2'));
    const td = buildTypedData(w.sim.venue.id, w.trader, w.wallet.signer, second.intent, first.nonce);
    const reused = { ...second, nonce: first.nonce, typedData: td, digest: digestOf(td) };
    expect(await w.sim.submit(reused, await w.wallet.sign(reused))).toEqual({ definite: false, reason: 'already_submitted' });
  });

  it('amend is refused at prepare, so the wallet is never asked', async () => {
    const w = world();
    expect(
      await refusal(
        w.sim.prepare(w.trader, w.wallet.signer, {
          kind: 'amend_order',
          symbol: 'BTC-USDC',
          clientOrderKey: 'order:t:am',
          amount: a('1'),
          price: a('1'),
        }),
      ),
    ).toBe('not_offered');
  });

  it('a failed withdrawal returns the amount and its fee', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:wf');
    const { prepared } = await w.run(w.wallet, w.trader, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: w.wallet.address,
      withdrawalKey: 'withdraw:t:wf',
    });
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('989'));
    expect(w.sim.settleWithdrawals('failed')).toBe(1);
    expect((await w.sim.withdrawal(w.trader, prepared.nonce)).value?.status).toBe('failed');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC').free).toBe(a('1000'));
  });

  it('money is conserved: deposits = free + locked + withdrawals + fees charged ± realised results, for every account', async () => {
    const w = world();
    const bidder = testWallet('bidder-cons');
    const bAcct = { venueId: w.sim.venue.id, owner: bidder.address, subAccount: null };
    const accounts = [
      [w.wallet, w.trader],
      [w.otherWallet, w.other],
      [bidder, bAcct],
    ] as const;
    for (const [, acct] of accounts) w.sim.deposit(acct, 'USDC', a('100000'), `chain:${acct.owner}:cons`);
    for (const [who, acct] of accounts)
      await w.run(who, acct, { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' });
    await w.run(w.otherWallet, w.other, order('BTC-PERP', 'sell', '60000', '0.1', 'order:o:cons'));
    await w.run(w.wallet, w.trader, order('BTC-PERP', 'buy', '60000', '0.1', 'order:t:cons'));
    await w.run(bidder, bAcct, order('BTC-PERP', 'buy', '61000', '0.1', 'order:b:cons'));
    await w.run(w.wallet, w.trader, order('BTC-PERP', 'sell', '61000', '0.04', 'order:t:cons:c', { reduceOnly: true, timeInForce: 'IOC' }));
    await w.run(w.wallet, w.trader, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: w.wallet.address,
      withdrawalKey: 'withdraw:t:cons',
    });
    for (const [, acct] of accounts) {
      const usdc = balanceOf((await w.sim.balances(acct)).value, 'USDC');
      expect(usdc.total).toBe(add(usdc.free, usdc.locked));
      const fills = (await w.sim.fills(acct, new Date(0))).value;
      const fees = fills.reduce((s3, f) => add(s3, add(f.venueFee, f.builderFee)), ZERO);
      const realised = fills.reduce((s3, f) => add(s3, f.realisedPnl ?? ZERO), ZERO);
      const withdrawn = acct === w.trader ? a('11') : ZERO; // 10 and its published fee of 1
      expect(add(add(usdc.total, add(fees, withdrawn)), sub(ZERO, realised))).toBe(a('100000'));
    }
  });
});

describe('TEST venue simulator: council round 2 regressions (every check runs again at submit)', () => {
  /** Sign `intent` by hand on the base action's nonce, as a caller that skipped prepare would. */
  async function forge(
    w: ReturnType<typeof world>,
    who: ConformanceWallet,
    account: UserVenueAccount,
    base: PreparedVenueAction,
    intent: VenueIntent,
  ) {
    const typedData = buildTypedData(w.sim.venue.id, account, who.signer, intent, base.nonce);
    const forged = { ...base, account, intent, typedData, digest: digestOf(typedData) };
    try {
      return await w.sim.submit(forged, await who.sign(forged));
    } catch (error) {
      return { thrown: (error as VenueRefusalError).refusal?.code ?? String(error) };
    }
  }
  const refusedCode = (o: unknown) => (o as { refusal?: { code: string } }).refusal?.code ?? (o as { thrown?: string }).thrown;

  it('Q1 a hand-built negative-amount order is refused and creates nothing', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100'), 'chain:t:q1');
    const base = await w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '60000', '0.001', 'order:t:q1'));
    expect(refusedCode(await forge(w, w.wallet, w.trader, base, order('BTC-USDC', 'buy', '60000', '-1', 'order:t:q1')))).toBe(
      'venue_rejected',
    );
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('100'), locked: ZERO });
  });

  it('Q2 a hand-built withdrawal from a sub-account is refused', async () => {
    const w = world();
    const sub = { ...w.trader, subAccount: 'sub-1' };
    w.sim.deposit(sub, 'USDC', a('100'), 'chain:t:q2');
    const base = await w.sim.prepare(w.trader, w.wallet.signer, {
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: w.wallet.address,
      withdrawalKey: 'withdraw:t:q2',
    });
    expect(refusedCode(await forge(w, w.wallet, sub, base, base.intent))).toBe('not_offered');
    expect(balanceOf((await w.sim.balances(sub)).value, 'USDC').free).toBe(a('100'));
  });

  it('Q3 a hand-built 1000x leverage is refused', async () => {
    const w = world();
    const base = await w.sim.prepare(w.trader, w.wallet.signer, {
      kind: 'update_leverage',
      symbol: 'BTC-PERP',
      leverageBps: 100_000,
      marginMode: 'isolated',
    });
    expect(
      refusedCode(
        await forge(w, w.wallet, w.trader, base, {
          kind: 'update_leverage',
          symbol: 'BTC-PERP',
          leverageBps: 10_000_000,
          marginMode: 'isolated',
        }),
      ),
    ).toBe('not_offered');
    expect((await w.sim.leverage(w.trader, 'BTC-PERP')).value).toBeNull();
  });

  it('Q4 a hand-built zero-price order is refused', async () => {
    const w = world();
    w.sim.deposit(w.other, 'BTC', a('1'), 'chain:o:q4');
    await w.run(w.otherWallet, w.other, order('BTC-USDC', 'sell', '60000', '1', 'order:o:q4'));
    const base = await w.sim.prepare(w.trader, w.wallet.signer, order('BTC-USDC', 'buy', '60000', '0.001', 'order:t:q4'));
    expect(refusedCode(await forge(w, w.wallet, w.trader, base, order('BTC-USDC', 'buy', '0', '1', 'order:t:q4')))).toBe('venue_rejected');
    expect((await w.sim.fills(w.trader, new Date(0))).value).toEqual([]);
  });
});

describe('TEST venue simulator: council round 3 follow-ups', () => {
  it('a re-send of a live order after the builder approval was lowered answers with the order, not a refusal', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100000'), 'chain:t:r3');
    await w.run(w.wallet, w.trader, { kind: 'approve_builder_fee', builder: '0xb11de4', maxFeeBps: a('5') });
    const intent = order('BTC-USDC', 'buy', '50000', '0.01', 'order:t:r3', { builderFee: { builder: '0xb11de4', feeBps: a('5') } });
    const first = await w.run(w.wallet, w.trader, intent);
    await w.run(w.wallet, w.trader, { kind: 'approve_builder_fee', builder: '0xb11de4', maxFeeBps: a('1') });
    const typedData = buildTypedData(w.sim.venue.id, w.trader, w.wallet.signer, intent, `${first.prepared.nonce}9`);
    const resend = { ...first.prepared, nonce: `${first.prepared.nonce}9`, typedData, digest: digestOf(typedData) };
    const again = await w.sim.submit(resend, await w.wallet.sign(resend));
    expect(again.definite && again.accepted && again.order?.status).toBe('open');
    expect((await w.sim.openOrders(w.trader)).value.length).toBe(1);
  });

  it('the venue throws rather than ever report a balance below zero', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('100'), 'chain:t:neg');
    // Reach past the venue's own checks, as only a bug could, and let the next action find it.
    const state = (w.sim as unknown as { accounts: Map<string, { balances: Map<string, { free: Amount }> }> }).accounts;
    for (const s2 of state.values()) s2.balances.get('USDC')!.free = a('-1');
    await expect(w.run(w.wallet, w.trader, { kind: 'approve_builder_fee', builder: '0xb11de4', maxFeeBps: a('1') })).rejects.toThrow(
      /TEST simulator invariant/,
    );
  });
});
