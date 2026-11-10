import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, houseFees, parseAmount, recipes, venueBuilderFeeReceivable } from '@intafaced/ledger-client';
import type { UserVenue, UserVenueAccount, UserVenueFill } from '@intafaced/venue-contracts';
import { BuilderFeePosterStopped, postBuilderFees } from './builder-fee-poster.js';
import { builderFeeRecon } from './builder-fee-recon.js';
import { InMemoryBuilderFeeStore, type BuilderFeeAccount, type BuilderFeeStop } from './builder-fee-store.js';

/**
 * OWNER 288 changes 1a to 1c, acceptance tests 1, 2, 4, 5 and 6 of `changes/b1-launch-postings.md` (project-state). The
 * ledger runs in `refuse` mode, as every real svc-ledger does (LEDGER_IDEMPOTENCY_CONFLICT_MODE=refuse): a key that
 * already booked a movement and is posted again with another body is refused with `ledger.idempotency_conflict`.
 *
 * Worked example, not recomputed in the assertions: on TEST venue `test-venue-key`, our two accounts A and B are the two
 * sides of trade `t1`. A pays a builder fee of 0.25 USDC and B pays 0.4, so we earn 0.65.
 */
const a = parseAmount;
const VENUE = 'test-venue-key';
const USER_A = '11111111-1111-4111-8111-1111111111a1';
const USER_B = '11111111-1111-4111-8111-1111111111b2';
const A: UserVenueAccount = { venueId: VENUE, owner: '0x00000000000000000000000000000000000000a1', subAccount: null };
const B: UserVenueAccount = { venueId: VENUE, owner: '0x00000000000000000000000000000000000000b2', subAccount: null };
const since = new Date('2026-11-10T00:00:00.000Z');
const filledAt = new Date('2026-11-10T01:00:00.000Z');

const fill = (fillId: string, clientId: string | null, builderFee: string, side: 'buy' | 'sell' = 'buy'): UserVenueFill => ({
  fillId,
  venueClientOrderId: clientId,
  symbol: 'BTC-PERP',
  side,
  price: a('60000'),
  amount: a('0.01'),
  role: side === 'buy' ? 'taker' : 'maker',
  venueFee: a('0.1'),
  builderFee: a(builderFee),
  feeAsset: 'USDC',
  realisedPnl: null,
  filledAt,
});

/** A venue that reports these fills per account, as many times as it is read. */
function venueWith(fills: Map<string, UserVenueFill[]>): () => Promise<UserVenue> {
  const venue = {
    venue: { id: VENUE, displayName: 'TEST key venue', kind: 'test' },
    async fills(account: UserVenueAccount) {
      return { value: fills.get(account.owner) ?? [], asOf: new Date() };
    },
    async markets() {
      return { value: [], asOf: new Date() };
    },
  } as unknown as UserVenue;
  return async () => venue;
}

/** The orders our door stored and signed for each account, by client order id. */
function ordersOf(sent: Record<string, string[]>) {
  return async (_venueId: string, account: UserVenueAccount, ids: readonly string[]) =>
    new Set(ids.filter((id) => (sent[account.owner] ?? []).includes(id)));
}

let ledger: MemoryLedger;
let store: InMemoryBuilderFeeStore;
let stops: BuilderFeeStop[];
const accounts = (): BuilderFeeAccount[] => [
  { userId: USER_A, account: A, since },
  { userId: USER_B, account: B, since },
];
beforeEach(() => {
  ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
  store = new InMemoryBuilderFeeStore(accounts);
  stops = [];
});
const deps = (fills: Map<string, UserVenueFill[]>, sent: Record<string, string[]>) => ({
  venue: venueWith(fills),
  ledger,
  store,
  ourOrders: ordersOf(sent),
  onStop: (s: BuilderFeeStop) => stops.push(s),
  now: () => new Date('2026-11-10T02:00:00.000Z'),
});
const earned = async () => (await ledger.balance(houseFees('builder', 'USDC'))).amount;

describe('one builder-fee fact per venue, account and fill (refuse mode)', () => {
  it('acceptance 1: two of our accounts on the two sides of one trade, different fees: two entries, the sum earned, the run completes', async () => {
    const fills = new Map([
      [A.owner, [fill('t1', 'cA1', '0.25', 'buy')]],
      [B.owner, [fill('t1', 'cB1', '0.4', 'sell')]],
    ]);
    const run = await postBuilderFees(deps(fills, { [A.owner]: ['cA1'], [B.owner]: ['cB1'] }));
    expect(run).toMatchObject({ posted: 2, refused: 0, notOurOrder: 0, complete: true });
    expect(await earned()).toBe(a('0.65'));
    expect((await ledger.balance(venueBuilderFeeReceivable(VENUE, 'USDC'))).amount).toBe(-a('0.65'));
    expect(await ledger.getTxByKey(`builder-fee:${VENUE}:${A.owner}:t1`)).not.toBeNull();
    expect(await ledger.getTxByKey(`builder-fee:${VENUE}:${B.owner}:t1`)).not.toBeNull();
    expect((await store.runState(VENUE)).lastCompleteAt).toEqual(new Date('2026-11-10T02:00:00.000Z'));
    expect(stops).toEqual([]);
  });

  it('acceptance 2: the same with equal fees is two entries, never one', async () => {
    const fills = new Map([
      [A.owner, [fill('t2', 'cA2', '0.25', 'buy')]],
      [B.owner, [fill('t2', 'cB2', '0.25', 'sell')]],
    ]);
    const run = await postBuilderFees(deps(fills, { [A.owner]: ['cA2'], [B.owner]: ['cB2'] }));
    expect(run.posted).toBe(2);
    expect(await earned()).toBe(a('0.5'));
    // The recon reads each side under its own key: both lines matched, the totals agree.
    const v = (
      await builderFeeRecon({ ...deps(fills, {}), routedOrders: async () => new Map() }, since, new Date('2026-11-10T03:00:00.000Z'))
    ).venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.lines.map((l) => [l.venueAccount, l.fillId, l.status])).toEqual([
      [A.owner, 't2', 'matched'],
      [B.owner, 't2', 'matched'],
    ]);
    expect(v.totals).toEqual([{ assetId: 'USDC', venueTotal: '0.5', ledgerTotal: '0.5', matched: true }]);
    expect(v.matched).toBe(true);
  });

  it('acceptance 4: a fill with a builder fee on an order we did not send posts nothing and reads "not our order"', async () => {
    const fills = new Map([[A.owner, [fill('t4', 'elsewhere-1', '0.3'), fill('t4b', null, '0.2'), fill('t4c', 'cA4', '0.1')]]]);
    const run = await postBuilderFees(deps(fills, { [A.owner]: ['cA4'], [B.owner]: ['elsewhere-1'] }));
    expect(run).toMatchObject({ posted: 1, notOurOrder: 2, complete: true });
    expect(await earned()).toBe(a('0.1'));
    expect(await ledger.getTxByKey(`builder-fee:${VENUE}:${A.owner}:t4`)).toBeNull();
    const rows = await store.inPeriod(VENUE, since, new Date('2026-11-11T00:00:00.000Z'));
    expect(rows.map((r) => [r.fillId, r.status, r.ledgerTxId])).toEqual([
      ['t4', 'not_our_order', null],
      ['t4b', 'not_our_order', null],
      ['t4c', 'posted', expect.any(String)],
    ]);
    // Read again, it is not posted either; the recon lists it as not ours, outside both totals, and not a break.
    expect((await postBuilderFees(deps(fills, { [A.owner]: ['cA4'] }))).posted).toBe(0);
    expect(await earned()).toBe(a('0.1'));
    const v = (
      await builderFeeRecon({ ...deps(fills, {}), routedOrders: async () => new Map() }, since, new Date('2026-11-10T03:00:00.000Z'))
    ).venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.lines.filter((l) => l.status === 'not_our_order').map((l) => l.fillId)).toEqual(['t4', 't4b']);
    expect(v.totals).toEqual([{ assetId: 'USDC', venueTotal: '0.1', ledgerTotal: '0.1', matched: true }]);
    expect(v.matched).toBe(true);
  });

  it("a fill first read as not ours is checked again, and booked once the door's order is found", async () => {
    const fills = new Map([[A.owner, [fill('t4r', 'cA4r', '0.2')]]]);
    expect((await postBuilderFees(deps(fills, {}))).notOurOrder).toBe(1);
    expect(await earned()).toBe(0n);
    const run = await postBuilderFees(deps(fills, { [A.owner]: ['cA4r'] }));
    expect(run).toMatchObject({ posted: 1, notOurOrder: 0 });
    expect(await earned()).toBe(a('0.2'));
    const [row] = await store.inPeriod(VENUE, since, new Date('2026-11-11T00:00:00.000Z'));
    expect(row).toMatchObject({ fillId: 't4r', status: 'posted' });
  });

  it('acceptance 5: the same fill delivered three times is one entry', async () => {
    const fills = new Map([[A.owner, [fill('t5', 'cA5', '0.25'), fill('t5', 'cA5', '0.25'), fill('t5', 'cA5', '0.25')]]]);
    await postBuilderFees(deps(fills, { [A.owner]: ['cA5'] }));
    await postBuilderFees(deps(fills, { [A.owner]: ['cA5'] }));
    await postBuilderFees(deps(fills, { [A.owner]: ['cA5'] }));
    expect(await earned()).toBe(a('0.25'));
  });

  it('acceptance 6: a fill whose key exists with another amount stops the run, as before, and the alert names the venue, the account and the fill', async () => {
    // The key already booked 0.25; the venue now reports 0.3 for the same fill of the same account.
    await ledger.post(
      recipes.builderFeeEarn({ venueId: VENUE, venueAccount: A.owner, fillId: 't6', assetId: 'USDC', amount: a('0.25'), userId: USER_A }),
    );
    const fills = new Map([
      [A.owner, [fill('t6', 'cA6', '0.3')]],
      [B.owner, [fill('t6b', 'cB6', '0.4')]],
    ]);
    const err = await postBuilderFees(deps(fills, { [A.owner]: ['cA6'], [B.owner]: ['cB6'] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuilderFeePosterStopped);
    expect((err as BuilderFeePosterStopped).cause).toMatchObject({ code: 'ledger.idempotency_conflict' });
    const stop = { venueId: VENUE, venueAccount: A.owner, fillId: 't6', code: 'ledger.idempotency_conflict' };
    expect(stops).toEqual([expect.objectContaining(stop)]);
    // The run stopped: B, after A in the list, is not posted this run, and nothing more is booked.
    expect(await earned()).toBe(a('0.25'));
    expect(await ledger.getTxByKey(`builder-fee:${VENUE}:${B.owner}:t6b`)).toBeNull();
    // The stop is recorded for the operations desk, and no complete run is.
    const state = await store.runState(VENUE);
    expect(state.lastStop).toMatchObject(stop);
    expect(state.lastCompleteAt).toBeNull();
    const v = (
      await builderFeeRecon({ ...deps(fills, {}), routedOrders: async () => new Map() }, since, new Date('2026-11-10T03:00:00.000Z'))
    ).venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.poster).toMatchObject({ lastCompleteAt: null, lastStopAt: '2026-11-10T02:00:00.000Z', lastStop: stop });
  });

  it('a stop before any account is read still names the venue, and an unread account leaves the run incomplete', async () => {
    const down = async () => {
      throw Object.assign(new Error('ledger unreachable'), { code: 'ledger.unavailable' });
    };
    const failing = new InMemoryBuilderFeeStore(accounts);
    failing.accounts = down;
    const err = await postBuilderFees({ ...deps(new Map(), {}), store: failing }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuilderFeePosterStopped);
    expect(stops).toEqual([expect.objectContaining({ venueId: VENUE, venueAccount: null, fillId: null, code: 'ledger.unavailable' })]);
    expect((await failing.runState(VENUE)).lastStop).toMatchObject({ code: 'ledger.unavailable' });

    // A store that can't record the stop doesn't hide it: the alert is still raised and the run still throws.
    const mute = new InMemoryBuilderFeeStore(accounts);
    mute.accounts = down;
    mute.markStopped = async () => {
      throw new Error('store down');
    };
    stops = [];
    await expect(postBuilderFees({ ...deps(new Map(), {}), store: mute })).rejects.toBeInstanceOf(BuilderFeePosterStopped);
    expect(stops).toHaveLength(1);

    // An account the venue refuses to read: the others post, and the run is not complete.
    const picky = venueWith(new Map([[A.owner, [fill('u1', 'cA', '0.1')]]]));
    const venue = await picky();
    const { VenueRefusalError } = await import('@intafaced/venue-contracts');
    const fills = venue.fills.bind(venue);
    (venue as { fills: UserVenue['fills'] }).fills = async (account, from) => {
      if (account.owner === B.owner)
        throw new VenueRefusalError({ venueId: VENUE, code: 'account_unknown', detail: 'TEST: unknown account' } as never);
      return fills(account, from);
    };
    const run = await postBuilderFees({ ...deps(new Map(), { [A.owner]: ['cA'] }), venue: async () => venue });
    expect(run).toMatchObject({ posted: 1, complete: false });
    expect((await store.runState(VENUE)).lastCompleteAt).toBeNull();
  });

  it('invariant: revenue equals the fees on our own orders, per account and fill, and no entry touches a customer account', async () => {
    const fills = new Map([
      [A.owner, [fill('i1', 'cA', '0.1'), fill('i2', 'cA', '0.2'), fill('shared', 'cA', '0.3'), fill('x', 'other', '9')]],
      [B.owner, [fill('shared', 'cB', '0.3'), fill('i3', 'cB', '0.4')]],
    ]);
    await postBuilderFees(deps(fills, { [A.owner]: ['cA'], [B.owner]: ['cB'] }));
    expect(await earned()).toBe(a('1.3'));
    expect((await ledger.balance(venueBuilderFeeReceivable(VENUE, 'USDC'))).amount).toBe(-a('1.3'));
    for (const r of await store.inPeriod(VENUE, since, new Date('2027-01-01T00:00:00.000Z'))) {
      if (r.status !== 'posted') continue;
      expect((await ledger.getTxByKey(`builder-fee:${VENUE}:${r.account.owner}:${r.fillId}`))?.entries.length).toBe(2);
    }
    for (const user of [USER_A, USER_B]) expect((await ledger.balances('user', user)).filter((b) => b.amount !== 0n)).toEqual([]);
  });
});
