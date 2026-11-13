import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueSignature,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';

// J-cex-spot-04 #2 #6 on the TEST venue: the rules a venue publishes for a spot market (smallest order value, price band
// around the middle of its own book, open orders per account) are published in its market list and enforced in its own
// words, and a rule it does not publish is reported as such and never enforced with a figure of its own. TEST figures.

const a = parseAmount;

function key(name: string) {
  return privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
}

async function signWith(k: ReturnType<typeof key>, prepared: PreparedVenueAction): Promise<VenueSignature> {
  const typed = prepared.typedData as TestVenueTypedData;
  const signature = await k.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  return { digest: prepared.digest, signature, signedBy: k.address.toLowerCase() };
}

const RULED: SimMarketConfig = {
  symbol: 'RUL-USDC',
  kind: 'spot',
  baseAsset: 'RUL',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC', 'ALO'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: a('0.1'),
  lotSize: a('0.01'),
  makerFeeBps: { known: true, value: a('1') },
  takerFeeBps: { known: true, value: a('3.5') },
  minOrderNotional: a('10'),
  priceBandBps: a('1000'),
  maxOpenOrders: 2,
};
const BARE: SimMarketConfig = {
  ...RULED,
  symbol: 'BAR-USDC',
  baseAsset: 'BAR',
  minOrderNotional: undefined,
  priceBandBps: undefined,
  maxOpenOrders: undefined,
};

const order = (symbol: string, side: 'buy' | 'sell', amount: string, price: string, clientOrderKey: string): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol,
  side,
  type: 'limit',
  amount: a(amount),
  price: a(price),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey,
  builderFee: null,
});

async function world() {
  const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 12)), markets: [RULED, BARE] });
  const trader = key('rules-trader');
  const maker = key('rules-maker');
  const acct = (k: ReturnType<typeof key>): UserVenueAccount => ({
    venueId: sim.venue.id,
    owner: k.address.toLowerCase(),
    subAccount: null,
  });
  sim.deposit(acct(trader), 'USDC', a('10000'), 'deposit:test-chain:0xrules-trader:0');
  sim.deposit(acct(maker), 'USDC', a('10000'), 'deposit:test-chain:0xrules-maker:0');
  sim.deposit(acct(maker), 'RUL', a('100'), 'deposit:test-chain:0xrules-maker:1');
  const place = async (k: ReturnType<typeof key>, intent: PlaceUserOrderIntent) => {
    const signer = { role: 'owner' as const, address: k.address.toLowerCase() };
    const prepared = await sim.prepare(acct(k), signer, intent);
    return sim.submit(prepared, await signWith(k, prepared));
  };
  // The book's middle is 100: a maker's bid at 99 and ask at 101.
  expect(await place(maker, order('RUL-USDC', 'buy', '1', '99', 'order:maker:rul:bid'))).toMatchObject({ definite: true, accepted: true });
  expect(await place(maker, order('RUL-USDC', 'sell', '1', '101', 'order:maker:rul:ask'))).toMatchObject({
    definite: true,
    accepted: true,
  });
  return { sim, trader, account: acct(trader), place };
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    if (err instanceof VenueRefusalError) return err.refusal;
    throw err;
  }
  throw new Error('expected a venue refusal');
}

describe('TEST venue simulator: a spot market publishes and enforces its own rules (J-cex-spot-04)', () => {
  it('#2 the market list publishes the smallest order value, the price band and the open-order cap; an unpublished rule reads null', async () => {
    const { sim } = await world();
    const markets = (await sim.markets(null)).value;
    const ruled = markets.find((m) => m.symbol === 'RUL-USDC')!;
    const bare = markets.find((m) => m.symbol === 'BAR-USDC')!;
    expect([ruled.minOrderNotional, ruled.priceBandBps, ruled.maxOpenOrders]).toEqual([a('10'), a('1000'), 2]);
    expect([bare.minOrderNotional, bare.priceBandBps, bare.maxOpenOrders]).toEqual([null, null, null]);
  });

  it('refuses below the smallest order value, outside the band and past the cap, each naming its rule and figure; inside them it takes the order', async () => {
    const { sim, trader, account, place } = await world();
    const below = await refusal(() => sim.preview(account, order('RUL-USDC', 'buy', '0.05', '100', 'order:t:rul:small')));
    expect(below.code).toBe('order_below_venue_min');
    expect(below.detail).toContain('10 USDC');
    // 10% of the middle (100): 90 to 110.
    const above = await refusal(() => sim.preview(account, order('RUL-USDC', 'buy', '1', '110.1', 'order:t:rul:high')));
    expect(above.code).toBe('price_outside_venue_band');
    expect(above.detail).toContain('from 90 to 110 USDC');
    expect((await sim.preview(account, order('RUL-USDC', 'buy', '1', '110', 'order:t:rul:edge'))).value).toBeTruthy();
    // Two resting orders fill the cap; the third is refused with the count and the cap, and nothing more is locked.
    expect(await place(trader, order('RUL-USDC', 'buy', '1', '95', 'order:t:rul:1'))).toMatchObject({ definite: true, accepted: true });
    expect(await place(trader, order('RUL-USDC', 'buy', '1', '95', 'order:t:rul:2'))).toMatchObject({ definite: true, accepted: true });
    const locked = (await sim.balances(account)).value.find((b) => b.asset === 'USDC')!.locked;
    const capped = await refusal(() => place(trader, order('RUL-USDC', 'buy', '1', '95', 'order:t:rul:3')));
    expect(capped.code).toBe('open_orders_above_venue_cap');
    expect(capped.detail).toContain('has 2 open orders');
    expect(capped.detail).toContain('allows 2');
    expect((await sim.balances(account)).value.find((b) => b.asset === 'USDC')!.locked).toBe(locked);
  });

  it('#6 a rule taken away is published as null and no longer enforced with any figure; put back, it applies again', async () => {
    const { sim, account } = await world();
    sim.setMarketLimits('RUL-USDC', { minOrderNotional: null, priceBandBps: null });
    const m = (await sim.markets(null)).value.find((x) => x.symbol === 'RUL-USDC')!;
    expect([m.minOrderNotional, m.priceBandBps, m.maxOpenOrders]).toEqual([null, null, 2]);
    expect((await sim.preview(account, order('RUL-USDC', 'buy', '0.05', '150', 'order:t:rul:free'))).value).toBeTruthy();
    sim.setMarketLimits('RUL-USDC', { minOrderNotional: a('10') });
    expect((await refusal(() => sim.preview(account, order('RUL-USDC', 'buy', '0.05', '100', 'order:t:rul:again')))).code).toBe(
      'order_below_venue_min',
    );
  });
});
