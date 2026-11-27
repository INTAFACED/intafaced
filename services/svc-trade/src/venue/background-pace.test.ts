import { describe, expect, it } from 'vitest';
import type { LedgerTx } from '@intafaced/ledger-client';
import type { AsOf, UserVenue, UserVenueAccount, UserVenueBalance, UserVenueFill, UserVenueMarket } from '@intafaced/venue-contracts';
import { VenueRefusalError } from '@intafaced/venue-contracts';
import { partial } from '@intafaced/service-kit/testing';
import { postBuilderFees } from '../builder-fee/builder-fee-poster.js';
import { InMemoryBuilderFeeStore, type BuilderFeeAccount } from '../builder-fee/builder-fee-store.js';
import { AccountPace } from './account-pace.js';
import { InMemoryBalanceWatchStore } from './balance-watch-store.js';
import { VenueBalanceWatch } from './balance-watch.js';

// The balance watch and the builder-fee poster read a paced share of the accounts, so the box's weight at a venue
// that limits it a minute stays the same however many accounts there are. A venue stand-in counts each read by account.

const VENUE = 'hl-testnet';
const owner = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

const none = <T>(): AsOf<readonly T[]> => ({ venueId: VENUE, value: [], asOf: new Date(0), reportedAt: null });

function countingVenue(opts: { refuse?: ReadonlySet<string> } = {}) {
  const reads = { balances: new Map<string, number>(), fills: new Map<string, number>() };
  const bump = (m: Map<string, number>, a: UserVenueAccount) => m.set(a.owner, (m.get(a.owner) ?? 0) + 1);
  const venue = partial<UserVenue>({
    venue: partial<UserVenue['venue']>({ id: VENUE }),
    markets: async () => none<UserVenueMarket>(),
    balances: async (a: UserVenueAccount) => {
      bump(reads.balances, a);
      return none<UserVenueBalance>();
    },
    fills: async (a: UserVenueAccount) => {
      bump(reads.fills, a);
      if (opts.refuse?.has(a.owner)) throw new VenueRefusalError({ venueId: VENUE, code: 'not_offered', detail: 'TEST refusal' });
      return none<UserVenueFill>();
    },
  });
  const total = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0);
  return { venue, reads, total };
}

function clock() {
  let ms = Date.UTC(2026, 10, 27, 11, 0, 0);
  return { now: () => new Date(ms), advance: (by: number) => (ms += by) };
}

describe('background readers keep their pace whatever the account count', () => {
  it('the balance watch reads 24 accounts a minute of 200, each in turn, and every account by the end of the round', async () => {
    const c = clock();
    const v = countingVenue();
    const watch = new VenueBalanceWatch({
      venue: async () => v.venue,
      accounts: async () => Array.from({ length: 200 }, (_, i) => ({ userId: `user-${i}`, owner: owner(i), subAccount: null })),
      store: new InMemoryBalanceWatchStore(),
      publish: async () => {},
      now: c.now,
      pace: new AccountPace(24, c.now),
    });
    const first = await watch.tick();
    expect(first).toMatchObject({ accounts: 200, read: 24, failed: 0 });
    // Ticks every 15 s: 6 accounts each after the first minute's credit; 24 a minute.
    let perMinute = 0;
    for (let t = 0; t < 4; t++) {
      c.advance(15_000);
      perMinute += (await watch.tick()).read;
    }
    expect(perMinute).toBe(24);
    for (let t = 0; t < 36; t++) {
      c.advance(15_000);
      await watch.tick();
    }
    // Ten minutes: 24 + 24 × 10 reads, each account once before any is read twice.
    expect(v.total(v.reads.balances)).toBe(264);
    expect(v.reads.balances.size).toBe(200);
    expect(Math.max(...v.reads.balances.values())).toBe(2);
  });

  it('without a pace the watch still reads every account on every tick', async () => {
    const c = clock();
    const v = countingVenue();
    const watch = new VenueBalanceWatch({
      venue: async () => v.venue,
      accounts: async () => Array.from({ length: 30 }, (_, i) => ({ userId: `user-${i}`, owner: owner(i), subAccount: null })),
      store: new InMemoryBalanceWatchStore(),
      publish: async () => {},
      now: c.now,
    });
    expect(await watch.tick()).toMatchObject({ accounts: 30, read: 30 });
    expect(v.total(v.reads.balances)).toBe(30);
  });

  it('the poster reads 6 accounts a minute; a run is complete only at the end of a round with every account read, as of its start', async () => {
    const c = clock();
    const v = countingVenue();
    const accounts: BuilderFeeAccount[] = Array.from({ length: 10 }, (_, i) => ({
      userId: `user-${i}`,
      account: { venueId: VENUE, owner: owner(i), subAccount: null },
      since: new Date(Date.UTC(2026, 10, 27, 10, 0, 0)),
    }));
    const store = new InMemoryBuilderFeeStore(() => accounts);
    const pace = new AccountPace(6, c.now);
    const run = () =>
      postBuilderFees({
        venue: async () => v.venue,
        ledger: { post: async () => partial<LedgerTx>({ id: 'tx' }) },
        store,
        ourOrders: async () => new Set(),
        now: c.now,
        pace,
      });
    const roundBegan = c.now();
    expect(await run()).toMatchObject({ accounts: 10, read: 6, complete: false });
    expect((await store.runState(VENUE)).lastCompleteAt).toBeNull();
    c.advance(30_000);
    expect(await run()).toMatchObject({ read: 3, complete: false });
    c.advance(30_000);
    expect(await run()).toMatchObject({ read: 1, complete: true });
    expect((await store.runState(VENUE)).lastCompleteAt).toEqual(roundBegan);
    expect(v.reads.fills.size).toBe(10);
  });

  it('a round with an account the venue would not read is not complete, and the next clean round is', async () => {
    const c = clock();
    const v = countingVenue({ refuse: new Set([owner(1)]) });
    const accounts: BuilderFeeAccount[] = [0, 1, 2].map((i) => ({
      userId: `user-${i}`,
      account: { venueId: VENUE, owner: owner(i), subAccount: null },
      since: new Date(Date.UTC(2026, 10, 27, 10, 0, 0)),
    }));
    const store = new InMemoryBuilderFeeStore(() => accounts);
    const pace = new AccountPace(2, c.now);
    const run = () =>
      postBuilderFees({
        venue: async () => v.venue,
        ledger: { post: async () => partial<LedgerTx>({ id: 'tx' }) },
        store,
        ourOrders: async () => new Set(),
        now: c.now,
        pace,
      });
    expect((await run()).unread).toHaveLength(1);
    c.advance(30_000);
    expect(await run()).toMatchObject({ read: 1, complete: false });
    accounts.splice(1, 1);
    c.advance(60_000);
    const began = c.now();
    expect(await run()).toMatchObject({ read: 2, complete: true });
    expect((await store.runState(VENUE)).lastCompleteAt).toEqual(began);
  });
});
