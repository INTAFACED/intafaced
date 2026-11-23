import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount, VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, seedTestVenue, type TestVenueTypedData } from '@intafaced/venue-sim';
import { InMemoryBalanceWatchStore } from './balance-watch-store.js';
import { VenueBalanceWatch, type VenueBalanceChange } from './balance-watch.js';

// J-cex-spot-15 #9 at the watch: one event per change in the venue balance, each with its source and the venue's own new
// total, read from the TEST venue simulator itself; a reading published twice carries the same ids. Every figure is TEST.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c9';
const OTHER_USER = '11111111-1111-4111-8111-1111111111ca';

async function world() {
  let now = Date.UTC(2026, 10, 24, 3, 0, 0);
  const clock = () => new Date((now += 1000));
  const sim = new TestVenueSimulator({ clock, markets: TEST_VENUE_MARKETS, chainId: 84532 });
  await seedTestVenue(sim);
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST balance watch trader')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
  };
  const published: { userId: string; change: VenueBalanceChange }[] = [];
  const store = new InMemoryBalanceWatchStore();
  let users = [USER];
  const watch = new VenueBalanceWatch({
    venue: async () => sim,
    accounts: async () => users.map((userId) => ({ userId, owner, subAccount: null })),
    store,
    publish: async (userId, change) => {
      published.push({ userId, change });
    },
    now: () => new Date(now),
  });
  const total = async (asset: string) => formatAmount((await sim.balances(account)).value.find((b) => b.asset === asset)?.total ?? 0n);
  return { sim, account, run, watch, published, store, total, setUsers: (u: string[]) => (users = u) };
}

describe('the venue balance watch (J-cex-spot-15 #9)', () => {
  it('starts from the venue totals it first reads and publishes nothing for what was already there', async () => {
    const w = await world();
    w.sim.deposit(w.account, 'USDC', a('1000'), '84532:0xaa:0');
    expect(await w.watch.tick()).toMatchObject({ accounts: 1, published: 0, failed: 0 });
    expect(w.published).toEqual([]);
  });

  it('publishes one event per deposit, each with its source, its id and the venue new total', async () => {
    const w = await world();
    w.sim.deposit(w.account, 'USDC', a('1000'), '84532:0xaa:0');
    await w.watch.tick();
    w.sim.deposit(w.account, 'USDC', a('25'), '84532:0xbb:0');
    w.sim.deposit(w.account, 'USDC', a('5'), '84532:0xcc:0');
    await w.watch.tick();
    expect(w.published.map((p) => [p.change.source, p.change.sourceId, p.change.change, p.change.total])).toEqual([
      ['deposit', '84532:0xbb:0', '25', '1025'],
      ['deposit', '84532:0xcc:0', '5', '1030'],
    ]);
    expect(w.published.at(-1)!.change.total).toBe(await w.total('USDC'));
    expect(w.published.every((p) => p.userId === USER)).toBe(true);
    // Nothing changed since: the next reading publishes nothing.
    await w.watch.tick();
    expect(w.published).toHaveLength(2);
  });

  it('names a spot fill as a trade on each asset it moved, ending on the venue totals', async () => {
    const w = await world();
    w.sim.deposit(w.account, 'USDC', a('100000'), '84532:0xaa:0');
    await w.watch.tick();
    const book = (await w.sim.book('BTC-USDC', 1)).value;
    const ask = book.asks[0]!.price;
    expect(
      await w.run({
        kind: 'place_order',
        symbol: 'BTC-USDC',
        side: 'buy',
        type: 'limit',
        amount: a('0.01'),
        price: ask,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: 'balance-watch:buy:1',
        builderFee: null,
      }),
    ).toMatchObject({ accepted: true });
    await w.watch.tick();
    const fill = (await w.sim.fills(w.account, new Date(0))).value[0]!;
    const byAsset = new Map(w.published.map((p) => [p.change.asset, p.change]));
    expect([...byAsset.keys()].sort()).toEqual(['BTC', 'USDC']);
    for (const asset of ['BTC', 'USDC']) {
      expect(byAsset.get(asset)).toMatchObject({ source: 'trade', sourceId: fill.fillId, total: await w.total(asset) });
    }
    expect(w.published).toHaveLength(2);
  });

  it('publishes a change the venue names no record for once, as other, with the venue total', async () => {
    const w = await world();
    w.sim.deposit(w.account, 'USDC', a('1000'), '84532:0xaa:0');
    await w.watch.tick();
    // A withdrawal is read by its nonce only: the watch sees the total fall with no record of it.
    await w.run({ kind: 'withdraw', asset: 'USDC', amount: a('100'), destination: w.account.owner, withdrawalKey: 'balance-watch:w1' });
    await w.watch.tick();
    expect(w.published).toHaveLength(1);
    expect(w.published[0]!.change).toMatchObject({ source: 'other', sourceId: null, total: await w.total('USDC') });
    expect(parseAmount(w.published[0]!.change.change) < 0n).toBe(true);
  });

  it('publishes the same ids again when it stopped before writing its cursor', async () => {
    const w = await world();
    w.sim.deposit(w.account, 'USDC', a('1000'), '84532:0xaa:0');
    await w.watch.tick();
    w.sim.deposit(w.account, 'USDC', a('25'), '84532:0xbb:0');
    const write = w.store.write.bind(w.store);
    w.store.write = async () => {
      throw new Error('stopped here');
    };
    expect(await w.watch.tick()).toMatchObject({ failed: 1 });
    w.store.write = write;
    await w.watch.tick();
    expect(w.published).toHaveLength(2);
    expect(w.published[0]!.change).toEqual(w.published[1]!.change);
  });

  it('tells each person whose wallet signed for the account, and no one else', async () => {
    const w = await world();
    w.setUsers([USER, OTHER_USER]);
    await w.watch.tick();
    w.sim.deposit(w.account, 'USDC', a('7'), '84532:0xdd:0');
    await w.watch.tick();
    expect(w.published.map((p) => p.userId).sort()).toEqual([USER, OTHER_USER].sort());
    expect(new Set(w.published.map((p) => p.change.changeId)).size).toBe(1);
  });
});
