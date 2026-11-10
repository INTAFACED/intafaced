import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PlaceUserOrderIntent, type PreparedVenueAction, type UserVenueAccount } from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import { buildTypedData, digestOf, type TestVenueTypedData } from './signing.js';
import { TEST_VENUE_MARKETS } from './http-server.js';

// The venue's own builder-fee cap (J-cex-spot-17 #3: "never above the venue's cap"): published per market on
// `markets()`, and enforced by the venue itself on an order, at prepare and again at submit.
const a = parseAmount;
const BUILDER = '0x7e57000000000000000000000000000000000b1d';

const SPOT: SimMarketConfig = {
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit'],
  timeInForce: ['GTC', 'ALO'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1') },
  takerFeeBps: { known: true, value: a('3.5') },
  builderFeeCapBps: { known: true, value: a('10') },
};
const UNCAPPED: SimMarketConfig = { ...SPOT, symbol: 'ETH-USDC', baseAsset: 'ETH', builderFeeCapBps: undefined };

function world() {
  const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0)), markets: [SPOT, UNCAPPED] });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet builder-cap')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const sign = async (prepared: PreparedVenueAction) => {
    const typed = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    return { digest: prepared.digest, signature, signedBy: owner };
  };
  return { sim, account, signer, sign };
}

const order = (symbol: string, feeBps: string, key: string): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol,
  side: 'buy',
  type: 'limit',
  amount: a('0.01'),
  price: a('50000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: key,
  builderFee: { builder: BUILDER, feeBps: a(feeBps) },
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    return (error as VenueRefusalError).refusal.code;
  }
  throw new Error('expected a refusal');
}

describe("the venue's builder-fee cap", () => {
  it('is published per market, and reads not known where the venue publishes none', async () => {
    const { sim } = world();
    const markets = (await sim.markets(null)).value;
    expect(markets.find((m) => m.symbol === 'BTC-USDC')?.builderFeeCapBps).toEqual({ known: true, value: a('10') });
    expect(markets.find((m) => m.symbol === 'ETH-USDC')?.builderFeeCapBps).toEqual({ known: false });
  });

  it('the stack TEST venue publishes a cap on every market it lists', () => {
    for (const m of TEST_VENUE_MARKETS) expect(m.builderFeeCapBps?.known, m.symbol).toBe(true);
  });

  it('an order at the cap is prepared; one above it is refused before signing', async () => {
    const w = world();
    w.sim.deposit(w.account, 'USDC', a('1000'), 'chain:cap:1');
    const approve = await w.sim.prepare(w.account, w.signer, { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('50') });
    expect((await w.sim.submit(approve, await w.sign(approve))).definite).toBe(true);
    await expect(w.sim.prepare(w.account, w.signer, order('BTC-USDC', '10', 'order:cap:at'))).resolves.toBeTruthy();
    expect(await code(w.sim.prepare(w.account, w.signer, order('BTC-USDC', '10.1', 'order:cap:above')))).toBe('builder_fee_above_cap');
    // No cap published: the venue checks only the account's own approval.
    await expect(w.sim.prepare(w.account, w.signer, order('ETH-USDC', '20', 'order:cap:none'))).resolves.toBeTruthy();
  });

  it('a hand-built action above the cap, signed, is refused again at submit and places nothing', async () => {
    const w = world();
    w.sim.deposit(w.account, 'USDC', a('1000'), 'chain:cap:2');
    const approve = await w.sim.prepare(w.account, w.signer, { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('50') });
    await w.sim.submit(approve, await w.sign(approve));
    const intent = order('BTC-USDC', '11', 'order:cap:hand');
    const nonce = String(Date.UTC(2026, 10, 9, 10, 0, 1) * 1000);
    const typedData = buildTypedData(w.sim.venue.id, w.account, w.signer, intent, nonce, w.sim.chainId);
    const prepared: PreparedVenueAction = {
      venueId: w.sim.venue.id,
      account: w.account,
      signer: w.signer,
      intent,
      nonce,
      venueClientOrderId: null,
      typedData,
      digest: digestOf(typedData),
      builderFee: { builder: BUILDER, feeBps: a('11') },
      preparedAt: new Date(),
    };
    const outcome = await w.sim.submit(prepared, await w.sign(prepared));
    expect(outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'builder_fee_above_cap' } });
    expect((await w.sim.openOrders(w.account)).value).toEqual([]);
  });
});
