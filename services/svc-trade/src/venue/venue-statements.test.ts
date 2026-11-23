import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount, VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { composeVenueStatement } from './venue-statements.js';

// J-cex-spot-07 #5 on the launch model: the statement lists exactly the venue account's orders placed, trades filled and
// money moved in [from, to), from the venue's own records, each row named with its source. Every figure is TEST.

const a = parseAmount;
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const HOUR = 3_600_000;

function world() {
  const clock = { now: T0 - HOUR };
  const sim = new TestVenueSimulator({ clock: () => new Date(clock.now), markets: TEST_VENUE_MARKETS, chainId: 84532 });
  const trader = (name: string) => {
    const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet venue statement ${name}`)));
    const owner = key.address.toLowerCase();
    const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
    const run = async (intent: VenueIntent) => {
      const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return { prepared, outcome: await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner }) };
    };
    return { account, owner, run };
  };
  return { sim, clock, me: trader('me'), maker: trader('maker') };
}

const order = (owner: string, key: string, side: 'buy' | 'sell', price: string): VenueIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side,
  type: 'limit',
  amount: a('0.001'),
  price: a(price),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${owner}:${key}`,
  builderFee: null,
});
const parse = (csv: string) => {
  const [head, ...rows] = csv.trimEnd().split('\n');
  const cols = head!.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
};

describe('composeVenueStatement (J-cex-spot-07 #5)', () => {
  it("lists exactly the range's orders, trades and money movements from the venue's records, with their source", async () => {
    const w = world();
    // Before the range: a deposit and a resting order.
    w.sim.deposit(w.me.account, 'USDC', a('1000'), 'chain:statement:before');
    w.sim.deposit(w.maker.account, 'BTC', a('1'), 'chain:statement:maker');
    await w.me.run(order(w.me.owner, 'before', 'buy', '19000'));
    // Inside it: a deposit, a filled buy against the maker's sell, a resting order and a withdrawal.
    w.clock.now = T0 + HOUR;
    w.sim.deposit(w.me.account, 'USDC', a('50'), 'chain:statement:inside');
    await w.maker.run(order(w.maker.owner, 'ask', 'sell', '20500'));
    await w.me.run(order(w.me.owner, 'take', 'buy', '20500'));
    await w.me.run(order(w.me.owner, 'rest', 'buy', '19500'));
    const out = await w.me.run({
      kind: 'withdraw',
      asset: 'USDC',
      amount: a('10'),
      destination: w.me.owner,
      withdrawalKey: `withdraw:${w.me.owner}:d1`,
    });
    // After it: a deposit.
    w.clock.now = T0 + 25 * HOUR;
    w.sim.deposit(w.me.account, 'USDC', a('5'), 'chain:statement:after');

    const built = await composeVenueStatement(
      { venue: w.sim, account: w.me.account, withdrawalNonces: [out.prepared.nonce] },
      { from: new Date(T0), to: new Date(T0 + 24 * HOUR) },
    );
    const rows = parse(built.csv);
    const ids = (record: string) => rows.filter((r) => r.record === record).map((r) => r.id);
    const name = w.sim.venue.displayName;
    expect(rows.every((r) => r.source === name)).toBe(true);
    expect(ids('order')).toHaveLength(2);
    expect(ids('order')).not.toContain(expect.stringContaining('before'));
    const myFills = (await w.sim.fills(w.me.account, new Date(0))).value;
    expect(myFills).toHaveLength(1);
    expect(ids('trade')).toEqual(myFills.map((f) => f.fillId));
    expect(ids('deposit')).toEqual(['chain:statement:inside']);
    expect(ids('withdrawal')).toEqual([out.prepared.nonce]);
    expect(rows.find((r) => r.record === 'withdrawal')).toMatchObject({ direction: 'out', amount: '10', asset: 'USDC' });
    expect(built).toMatchObject({ orders: 2, trades: myFills.length, movements: 2 });
  });

  it('fails as incomplete where the venue keeps no order history, rather than leave orders out', async () => {
    const w = world();
    const venue = Object.assign(Object.create(Object.getPrototypeOf(w.sim)), w.sim, { orderHistory: undefined });
    await expect(
      composeVenueStatement({ venue, account: w.me.account, withdrawalNonces: [] }, { from: new Date(T0), to: new Date(T0 + HOUR) }),
    ).rejects.toThrow('keeps no order history');
  });
});
