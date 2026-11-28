import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { AsOf, UserVenueAccount, UserVenueAccountSummary, VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { InMemoryPreparedActionStore } from '../venue/prepared-action-store.js';
import { sampleOf, type MarginSampleStore, type VenueMarginSample } from '../venue/venue-margin-samples.js';
import { TRADE_ADMIN_VENUE_ACCOUNTS_GET, TRADE_ADMIN_VENUE_ACCOUNTS_ORDERS } from '@intafaced/contracts/trade-admin-procedures';
import { TradeOpsError, type AuditWrite } from './common.js';
import {
  VENUE_ACCOUNTS_READ_KIND,
  VENUE_ORDERS_LIST_KIND,
  readVenueAccounts,
  readVenueOrders,
  venueAccountsReadWire,
  venueOrdersReadWire,
} from './venue-account-read.js';

// J-derivatives-26 #8: a founder reads one person's venue account, its margin now and its ratio history, every figure
// the venue's own with its as-of time; the read is audited before the venue is asked, and changes nothing. Every figure
// is TEST.

const a = parseAmount;
const XCRS = TEST_VENUE_MARKETS.find((m) => m.symbol === 'XCRS-PERP')!;
const PERSON = '33333333-3333-4333-8333-3333333333a1';
const FOUNDER = { userId: 'founder-a', sid: 's-f', scopes: ['admin:read'] } as Principal;
const CUSTOMER = { userId: PERSON, sid: 's-c', scopes: ['trade:read'] } as Principal;

/** The readings kept in memory, as the SQL store keeps them: a reading equal to the latest is not kept again. */
class MemorySamples implements MarginSampleStore {
  readonly rows = new Map<string, VenueMarginSample[]>();
  private key = (x: UserVenueAccount) => `${x.venueId}:${x.owner}:${x.subAccount ?? ''}`;
  async record(account: UserVenueAccount, read: AsOf<UserVenueAccountSummary>) {
    const s = sampleOf(read);
    const list = this.rows.get(this.key(account)) ?? [];
    const last = list.at(-1);
    const same = (x: VenueMarginSample) => JSON.stringify({ ...x, asOf: 0 }, (_k, v) => (typeof v === 'bigint' ? `${v}` : v));
    if (!last || same(last) !== same(s)) list.push(s);
    this.rows.set(this.key(account), list);
  }
  async history(account: UserVenueAccount) {
    return [...(this.rows.get(this.key(account)) ?? [])].reverse();
  }
}

async function world() {
  let now = Date.UTC(2026, 10, 23, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [XCRS] });
  const store = new InMemoryPreparedActionStore();
  const wallet = (name: string) => {
    const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet venue account read ${name}`)));
    const owner = key.address.toLowerCase();
    const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
    const sign = async (intent: VenueIntent) => {
      const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return { prepared, signature: { digest: prepared.digest, signature, signedBy: owner } };
    };
    return { owner, account, sign };
  };
  const maker = wallet('maker');
  const me = wallet('me');
  sim.deposit(maker.account, 'USDC', a('100000'), 'chain:venue-account-read:maker');
  sim.deposit(me.account, 'USDC', a('300'), 'chain:venue-account-read:me');
  const cross: VenueIntent = { kind: 'update_leverage', symbol: 'XCRS-PERP', leverageBps: 200_000, marginMode: 'cross' };
  const order = (side: 'buy' | 'sell', key: string): VenueIntent => ({
    kind: 'place_order',
    symbol: 'XCRS-PERP',
    side,
    type: 'limit',
    amount: a('50'),
    price: a('100'),
    timeInForce: side === 'sell' ? 'GTC' : 'IOC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  const onVenue = async (w: ReturnType<typeof wallet>, intent: VenueIntent) => {
    const { prepared, signature } = await w.sign(intent);
    now += 1000;
    return sim.submit(prepared, signature);
  };
  await onVenue(maker, cross);
  await onVenue(maker, order('sell', 'maker:ask'));
  // The person's own actions, signed through our door: the store names their venue account.
  for (const [key, intent] of [
    ['cross:me', cross],
    ['order:me:open', order('buy', 'order:me:open')],
  ] as const) {
    const { prepared, signature } = await me.sign(intent);
    await store.insertOnce(PERSON, key, prepared, new Date(now));
    await store.signOnce(PERSON, key, signature, new Date(now));
    await store.recordOutcome(PERSON, key, await sim.submit(prepared, signature));
    now += 1000;
  }
  const audits: Array<{ row: AuditWrite; at: Date }> = [];
  const samples = new MemorySamples();
  const deps = {
    audit: async (row: AuditWrite, at: Date) => {
      audits.push({ row, at });
      return `audit-${audits.length}`;
    },
    venue: async () => sim,
    store,
    samples,
    now: () => new Date(now),
  };
  const tick = (ms: number) => {
    now += ms;
  };
  return { sim, me, deps, audits, samples, tick };
}

describe('readVenueAccounts (J-derivatives-26 #8)', () => {
  it("reads the person's venue account, its margin now and its ratio history as the venue reported them, audited first", async () => {
    const w = await world();
    // The person's own reads kept the venue's readings: healthy at 100, then a margin call at 96.50.
    await w.samples.record(w.me.account, await w.sim.accountSummary(w.me.account));
    w.tick(5000);
    await w.samples.record(w.me.account, await w.sim.accountSummary(w.me.account)); // the same reading: not kept again
    w.sim.setMark('XCRS-PERP', a('96.5'));
    w.tick(5000);
    const call = await w.sim.accountSummary(w.me.account);
    await w.samples.record(w.me.account, call);
    expect(call.value.cross?.state).toBe('margin_call');

    const read = await readVenueAccounts(w.deps, FOUNDER, { userId: PERSON });
    expect(w.audits).toEqual([
      {
        row: expect.objectContaining({ kind: VENUE_ACCOUNTS_READ_KIND, operatorId: 'founder-a', accountId: PERSON }),
        at: expect.any(Date),
      },
    ]);
    expect(read).toMatchObject({ userId: PERSON, venueId: w.sim.venue.id, source: w.sim.venue.displayName, auditId: 'audit-1' });
    expect(read.accounts.map((x) => x.owner)).toEqual([w.me.owner]);
    const [account] = read.accounts;
    // Now: the venue's cross margin, exact.
    expect(account!.now).toEqual(sampleOf(await w.sim.accountSummary(w.me.account)));
    expect(account!.now?.crossState).toBe('margin_call');
    // History, newest first: the margin call, then healthy; the repeated healthy reading was kept once.
    expect(account!.history.map((h) => h.crossState)).toEqual(['margin_call', 'healthy']);
    expect(account!.history[0]!.marginRatio).toEqual(call.value.cross!.marginRatio);
    // On the wire: decimal strings and ISO times.
    const wire = TRADE_ADMIN_VENUE_ACCOUNTS_GET.output.parse(venueAccountsReadWire(read));
    expect(wire.accounts[0]!.history[0]).toMatchObject({ equity: formatAmount(call.value.cross!.equity), asOf: call.asOf.toISOString() });
  });

  it('refuses a caller without admin:read, before any audit or venue read', async () => {
    const w = await world();
    await expect(readVenueAccounts(w.deps, CUSTOMER, { userId: PERSON })).rejects.toBeInstanceOf(Error);
    expect(w.audits).toEqual([]);
  });

  it('refuses trade.user_venue_off with the door off, and lists no account for a person who signed none', async () => {
    const w = await world();
    await expect(readVenueAccounts({ ...w.deps, venue: null }, FOUNDER, { userId: PERSON })).rejects.toMatchObject({
      code: 'trade.user_venue_off',
    });
    const other = await readVenueAccounts(w.deps, FOUNDER, { userId: '33333333-3333-4333-8333-3333333333b2' });
    expect(other.accounts).toEqual([]);
    expect(w.audits.map((x) => x.row.accountId)).toEqual(['33333333-3333-4333-8333-3333333333b2']);
  });

  it('names the person by user id only', async () => {
    const w = await world();
    await expect(readVenueAccounts(w.deps, FOUNDER, { userId: '0xabc' })).rejects.toBeInstanceOf(TradeOpsError);
    expect(w.audits).toEqual([]);
  });
});

describe('readVenueOrders (J-ops-console-02 #3)', () => {
  it("lists the person's orders on their own venue account as the venue keeps them, newest first, audited first", async () => {
    const w = await world();
    const read = await readVenueOrders(w.deps, FOUNDER, { userId: PERSON, limit: 200 });
    expect(w.audits).toEqual([
      {
        row: expect.objectContaining({ kind: VENUE_ORDERS_LIST_KIND, operatorId: 'founder-a', accountId: PERSON, objectId: PERSON }),
        at: expect.any(Date),
      },
    ]);
    const history = (await w.sim.orderHistory!(w.me.account)).value;
    expect(history).toHaveLength(1);
    const [{ order, placedAt }] = history as [(typeof history)[number]];
    expect(read).toMatchObject({
      userId: PERSON,
      venueId: w.sim.venue.id,
      source: w.sim.venue.displayName,
      truncated: false,
      auditId: 'audit-1',
    });
    expect(read.orders).toEqual([
      {
        owner: w.me.owner,
        subAccount: null,
        venueClientOrderId: order.venueClientOrderId,
        venueOrderId: order.venueOrderId,
        symbol: 'XCRS-PERP',
        side: 'buy',
        type: 'limit',
        status: order.status,
        amount: a('50'),
        filled: order.filled,
        price: a('100'),
        averagePrice: order.averagePrice,
        placedAt,
      },
    ]);
    // The maker's order is on another person's account: never this person's.
    expect(read.orders.every((o) => o.owner === w.me.owner)).toBe(true);
    const wire = TRADE_ADMIN_VENUE_ACCOUNTS_ORDERS.output.parse(venueOrdersReadWire(read));
    expect(wire.orders[0]).toMatchObject({ amount: '50', price: '100', placedAt: placedAt.toISOString() });
  });

  it('cuts to the limit and says an older order exists', async () => {
    const w = await world();
    const sell: VenueIntent = {
      kind: 'place_order',
      symbol: 'XCRS-PERP',
      side: 'sell',
      type: 'limit',
      amount: a('1'),
      price: a('200'),
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: 'order:me:rest',
      builderFee: null,
    };
    w.tick(1000);
    const { prepared, signature } = await w.me.sign(sell);
    await w.sim.submit(prepared, signature);
    const read = await readVenueOrders(w.deps, FOUNDER, { userId: PERSON, limit: 1 });
    expect(read.truncated).toBe(true);
    expect(read.orders.map((o) => [o.side, o.price])).toEqual([['sell', a('200')]]);
  });

  it('refuses without admin:read or with the door off, and lists nothing for a person who signed for no account', async () => {
    const w = await world();
    await expect(readVenueOrders(w.deps, CUSTOMER, { userId: PERSON, limit: 10 })).rejects.toBeInstanceOf(Error);
    expect(w.audits).toEqual([]);
    await expect(readVenueOrders({ ...w.deps, venue: null }, FOUNDER, { userId: PERSON, limit: 10 })).rejects.toMatchObject({
      code: 'trade.user_venue_off',
    });
    const other = await readVenueOrders(w.deps, FOUNDER, { userId: '33333333-3333-4333-8333-3333333333b2', limit: 10 });
    expect(other).toMatchObject({ orders: [], truncated: false, asOf: null });
  });

  it('refuses not_offered on a venue that publishes no order history, never an empty list', async () => {
    const w = await world();
    const bare = Object.assign(Object.create(Object.getPrototypeOf(w.sim)), w.sim, { orderHistory: undefined });
    await expect(readVenueOrders({ ...w.deps, venue: async () => bare }, FOUNDER, { userId: PERSON, limit: 10 })).rejects.toMatchObject({
      code: 'trade.venue.not_offered',
    });
  });
});
