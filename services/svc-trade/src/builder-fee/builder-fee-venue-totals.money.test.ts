import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import {
  VenueRefusalError,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueFill,
  type VenueBuilderTotal,
} from '@intafaced/venue-contracts';
import { postBuilderFees } from './builder-fee-poster.js';
import { builderFeeRecon } from './builder-fee-recon.js';
import { InMemoryBuilderFeeStore, type BuilderFeeAccount } from './builder-fee-store.js';

/**
 * OWNER 288 change 1e, acceptance tests 7 and 8 of `changes/b1-launch-postings.md` (project-state), and J-derivatives-17
 * #1 and #3: the venue's own totals for our builder address decide. The ledger runs in `refuse` mode.
 *
 * Worked example, not recomputed in the assertions: our account A fills twice on TEST venue `test-venue-totals`, with
 * builder fees of 0.25 and 0.4 USDC on orders our door sent. The ledger records 0.65 earned and 0.65 owed. The venue's
 * own figures for our builder address say the same: 0.65 earned, 0.65 unclaimed.
 */
const a = parseAmount;
const VENUE = 'test-venue-totals';
const USER = '11111111-1111-4111-8111-1111111111e1';
const BUILDER = '0x00000000000000000000000000000000000000e0';
const A: UserVenueAccount = { venueId: VENUE, owner: '0x00000000000000000000000000000000000000a1', subAccount: null };
const since = new Date('2026-11-10T00:00:00.000Z');
const to = new Date('2026-11-10T03:00:00.000Z');
const READ_AT = new Date('2026-11-10T02:30:00.000Z');
const TOTALS_AT = new Date('2026-11-10T02:20:00.000Z');

const fill = (fillId: string, builderFee: string): UserVenueFill => ({
  fillId,
  venueClientOrderId: `c-${fillId}`,
  symbol: 'BTC-PERP',
  side: 'sell',
  price: a('60000'),
  amount: a('0.01'),
  role: 'taker',
  venueFee: a('0.1'),
  builderFee: a(builderFee),
  feeAsset: 'USDC',
  realisedPnl: null,
  filledAt: new Date('2026-11-10T01:00:00.000Z'),
});
const twoFills = () => [fill('t1', '0.25'), fill('t2', '0.4')];

type Totals = 'none' | 'not_known' | 'refused' | 'down' | readonly VenueBuilderTotal[];

/** A venue that reports `fills` for A, and its own builder totals for our address as `totals` says. */
function venueWith(fills: UserVenueFill[], totals: Totals): () => Promise<UserVenue> {
  const venue = {
    venue: { id: VENUE, displayName: 'TEST totals venue', kind: 'test' },
    async fills() {
      return { value: fills, asOf: READ_AT };
    },
    async markets() {
      return { value: [], asOf: READ_AT };
    },
    ...(totals === 'none'
      ? {}
      : {
          async builderTotals(builder: string) {
            if (totals === 'refused') throw new VenueRefusalError({ venueId: VENUE, code: 'not_offered', detail: 'TEST' } as never);
            if (totals === 'down') throw new VenueRefusalError({ venueId: VENUE, code: 'venue_down', detail: 'TEST' } as never);
            if (totals === 'not_known') return { value: { known: false }, asOf: TOTALS_AT };
            return { value: { known: true, value: { builder, assets: totals } }, asOf: TOTALS_AT };
          },
        }),
  } as unknown as UserVenue;
  return async () => venue;
}

let ledger: MemoryLedger;
let store: InMemoryBuilderFeeStore;
const accounts = (): BuilderFeeAccount[] => [{ userId: USER, account: A, since }];
beforeEach(() => {
  ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
  store = new InMemoryBuilderFeeStore(accounts);
});
const ours = async (_v: string, _a: UserVenueAccount, ids: readonly string[]) => new Set(ids);
const venueTotals = (earned: string, unclaimed = earned): VenueBuilderTotal[] => [
  { asset: 'USDC', earned: a(earned), unclaimed: a(unclaimed) },
];

async function recon(fills: UserVenueFill[], totals: Totals, builder: string | null = BUILDER) {
  const venue = venueWith(fills, totals);
  await postBuilderFees({ venue, ledger, store, ourOrders: ours, now: () => READ_AT });
  const read = await builderFeeRecon({ venue, ledger, store, routedOrders: async () => new Map(), builder, now: () => READ_AT }, since, to);
  const v = read.venues[0]!;
  if (v.state !== 'read') throw new Error(`venue not read: ${JSON.stringify(v)}`);
  return v;
}

describe("the venue's own totals decide (OWNER 288 change 1e)", () => {
  it('J-derivatives-17 #1 and #3: fills, earned total and unclaimed all match: matched, with the fills compared and the time read through', async () => {
    const v = await recon(twoFills(), venueTotals('0.65'));
    expect(v).toMatchObject({ verdict: 'matched', matched: true, compared: 2 });
    // The time read through is the oldest of the venue's reads: its totals, read before its fills.
    expect(v.asOf).toBe(TOTALS_AT.toISOString());
    expect(v.venueTotals).toEqual({
      state: 'known',
      builder: BUILDER,
      asOf: TOTALS_AT.toISOString(),
      rows: [
        {
          assetId: 'USDC',
          ledgerEarned: '0.65',
          venueEarned: '0.65',
          ledgerOwed: '0.65',
          venueUnclaimed: '0.65',
          earnedMatched: true,
          owedMatched: true,
        },
      ],
    });
  });

  it('acceptance 7: a period with no fills reads "nothing to compare", never matched', async () => {
    const v = await recon([], []);
    expect(v).toMatchObject({ verdict: 'nothing_to_compare', matched: false, compared: 0, lines: [] });
    expect(v.venueTotals).toMatchObject({ state: 'known', rows: [] });
  });

  it("acceptance 8: our earned total one unit below the venue's, with every fill matched, is a break", async () => {
    const unit = '0.000000000000000001';
    expect(a(unit)).toBe(1n);
    const v = await recon(twoFills(), venueTotals('0.650000000000000001'));
    expect(v.lines.map((l) => l.status)).toEqual(['matched', 'matched']);
    expect(v.totals).toEqual([{ assetId: 'USDC', venueTotal: '0.65', ledgerTotal: '0.65', matched: true }]);
    expect(v).toMatchObject({ verdict: 'break', matched: false, compared: 2 });
    expect(v.venueTotals).toMatchObject({
      state: 'known',
      rows: [{ assetId: 'USDC', ledgerEarned: '0.65', venueEarned: '0.650000000000000001', earnedMatched: false }],
    });
  });

  it("J-derivatives-17 #3: what the ledger says is owed must equal the venue's unclaimed figure; a gap is a break", async () => {
    // The venue says 0.1 of the 0.65 was claimed, and the ledger has no Collect for it: owed 0.65 against unclaimed 0.55.
    const v = await recon(twoFills(), venueTotals('0.65', '0.55'));
    expect(v).toMatchObject({ verdict: 'break', matched: false });
    expect(v.venueTotals).toMatchObject({
      rows: [
        { ledgerEarned: '0.65', venueEarned: '0.65', earnedMatched: true, ledgerOwed: '0.65', venueUnclaimed: '0.55', owedMatched: false },
      ],
    });
    expect(v.owed).toEqual([{ assetId: 'USDC', amount: '0.65', state: 'owed' }]);
  });

  it('a payout the ledger received counts in its earned total and leaves the venue owing the rest', async () => {
    await ledger.post(recipes.builderFeeReceive({ venueId: VENUE, payoutId: 'claim-1', assetId: 'USDC', amount: a('0.1') }));
    // Received before it was earned here, so the receivable runs 0.1 ahead until the fills post; then 0.55 is owed.
    const v = await recon(twoFills(), venueTotals('0.65', '0.55'));
    expect(v.venueTotals).toMatchObject({
      rows: [
        { ledgerEarned: '0.65', venueEarned: '0.65', ledgerOwed: '0.55', venueUnclaimed: '0.55', earnedMatched: true, owedMatched: true },
      ],
    });
    expect(v.verdict).toBe('matched');
  });

  it('a fee asset only the venue reports is a row and a break, never left out', async () => {
    const v = await recon(twoFills(), [...venueTotals('0.65'), { asset: 'BTC', earned: a('0.0001'), unclaimed: a('0.0001') }]);
    expect(v.verdict).toBe('break');
    expect(v.venueTotals).toMatchObject({
      rows: [
        { assetId: 'BTC', ledgerEarned: '0', venueEarned: '0.0001', earnedMatched: false },
        { assetId: 'USDC', earnedMatched: true, owedMatched: true },
      ],
    });
  });

  it('totals the venue cannot give leave the fills compared and the verdict "totals unknown", never matched and never zero', async () => {
    for (const [totals, builder, reason] of [
      [venueTotals('0.65'), null, 'no_builder_address'],
      ['none', BUILDER, 'venue_reads_none'],
      ['not_known', BUILDER, 'venue_not_known'],
      ['refused', BUILDER, 'venue_refused'],
    ] as const) {
      ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
      store = new InMemoryBuilderFeeStore(accounts);
      const v = await recon(twoFills(), totals, builder);
      expect(v, reason).toMatchObject({
        verdict: 'totals_unknown',
        matched: false,
        compared: 2,
        venueTotals: { state: 'unknown', reason },
      });
    }
  });

  it('a fill-by-fill break stays a break when the totals are unknown, and a venue that is down is unknown as a whole', async () => {
    // The poster has posted t1 only; the venue now reports t2 as well, so t2 is not in the ledger.
    await postBuilderFees({ venue: venueWith([fill('t1', '0.25')], 'not_known'), ledger, store, ourOrders: ours, now: () => READ_AT });
    const read = await builderFeeRecon(
      {
        venue: venueWith(twoFills(), 'not_known'),
        ledger,
        store,
        routedOrders: async () => new Map(),
        builder: BUILDER,
        now: () => READ_AT,
      },
      since,
      to,
    );
    const v = read.venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.lines.map((l) => [l.fillId, l.status])).toEqual([
      ['t1', 'matched'],
      ['t2', 'not_in_ledger'],
    ]);
    expect(v).toMatchObject({ verdict: 'break', matched: false, venueTotals: { state: 'unknown', reason: 'venue_not_known' } });
    const down = await builderFeeRecon(
      { venue: venueWith(twoFills(), 'down'), ledger, store, routedOrders: async () => new Map(), builder: BUILDER, now: () => READ_AT },
      since,
      to,
    );
    expect(down.venues).toEqual([expect.objectContaining({ state: 'unknown', code: 'venue.venue_down' })]);
  });

  it('invariant: the recon reads only; it posts nothing, whatever it finds', async () => {
    const venue = venueWith(twoFills(), venueTotals('9'));
    await postBuilderFees({ venue, ledger, store, ourOrders: ours, now: () => READ_AT });
    const before = await ledger.balances('treasury', `venue-builder-fee:${VENUE}`);
    const v = await builderFeeRecon(
      { venue, ledger, store, routedOrders: async () => new Map(), builder: BUILDER, now: () => READ_AT },
      since,
      to,
    );
    expect(v.venues[0]).toMatchObject({ verdict: 'break' });
    expect(await ledger.balances('treasury', `venue-builder-fee:${VENUE}`)).toEqual(before);
  });
});
