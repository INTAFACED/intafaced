import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  refuseTestVenueOutsideTest,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import { defineUserVenueConformance, type ConformanceWallet } from './conformance.js';
import type { TestVenueTypedData } from './signing.js';

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
    leverageBps: null,
    marginMode: null,
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
    async setup() {
      const w = world();
      return {
        venue: w.sim,
        trader: { account: w.trader, wallet: w.wallet, agent: w.agent },
        other: { account: w.other, wallet: w.otherWallet },
        spot: { symbol: 'BTC-USDC', base: 'BTC', quote: 'USDC', price: a('60000'), size: a('0.01') },
        async fund(account, asset, amount, ref) {
          w.sim.deposit(account, asset, amount, ref);
        },
        loseNextAnswer: () => {
          w.sim.switches.loseAnswers = 1;
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
    // Maker 1 bps of 6,000 = 0.6; builder 0.5 bps = 0.3; taken in BTC at the fill price.
    expect([fill.role, fill.price, fill.amount, fill.venueFee, fill.builderFee, fill.feeAsset]).toEqual([
      'maker',
      a('60000'),
      a('0.1'),
      a('0.6'),
      a('0.3'),
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
    order('BTC-PERP', side, price, size, key, { leverageBps: 100_000, marginMode: 'isolated', ...extra });

  it('#5 a margin mode the venue does not offer is refused, and nothing changes', async () => {
    const w = world();
    w.sim.deposit(w.trader, 'USDC', a('1000'), 'chain:t:d5');
    expect(
      await refusal(w.sim.prepare(w.trader, w.wallet.signer, perpOrder('buy', '60000', '0.01', 'order:t:d5', { marginMode: 'cross' }))),
    ).toBe('not_offered');
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('1000'), locked: ZERO });
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
    expect(balanceOf((await w.sim.balances(w.trader)).value, 'USDC')).toMatchObject({ free: a('397.3'), locked: ZERO });

    w.sim.setMark('BTC-PERP', a('61000'));
    positions = (await w.sim.positions(w.trader)).value;
    expect(positions[0]!.unrealisedPnl).toBe(a('100'));

    await w.run(w.otherWallet, w.other, perpOrder('buy', '61000', '0.1', 'order:maker:d10'));
    const close40 = perpOrder('sell', '61000', '0.04', 'order:t:d10:close1', { reduceOnly: true });
    await w.run(w.wallet, w.trader, close40);
    await w.run(w.wallet, w.trader, close40); // the repeated close id is answered once
    await w.run(w.wallet, w.trader, perpOrder('sell', '61000', '0.06', 'order:t:d10:close2', { reduceOnly: true }));
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
    await w.run(w.wallet, w.trader, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'TEST bot' });
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
