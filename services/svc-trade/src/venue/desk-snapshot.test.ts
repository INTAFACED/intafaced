/**
 * `venue.deskSnapshot`: the launch desk's read of a person's own venue accounts for svc-notify's Telegram alerts. Every
 * figure is the venue's; spot fills are left out; margin use comes from the venue's own margin summary and is null, never
 * zero, where the venue reads none; the week runs from Monday 00:00 UTC.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type UserVenue, type UserVenueFill, type UserVenueMarket } from '@intafaced/venue-contracts';
import { partial } from '@intafaced/service-kit/testing';
import { tradeDeskSnapshotSchema } from '@intafaced/contracts/trade-desk-snapshot';
import type { PreparedActionStore } from './prepared-action-store.js';
import { marginUseOf, readDeskSnapshot, weekStartOf } from './desk-snapshot.js';

const a = parseAmount;
const OWNER = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-11-27T10:00:00Z'); // a Friday

function fill(fillId: string, symbol: string, filledAt: string, realised: string | null, fee = '0.5'): UserVenueFill {
  return {
    fillId,
    venueClientOrderId: null,
    symbol,
    side: 'sell',
    price: a('100'),
    amount: a('1'),
    role: 'taker',
    venueFee: a(fee),
    builderFee: a('0.1'),
    feeAsset: 'USDC',
    realisedPnl: realised === null ? null : a(realised),
    filledAt: new Date(filledAt),
  };
}

function venue(opts: { summary?: boolean; down?: boolean } = {}): UserVenue {
  const asOf = <T>(value: T) => ({ venueId: 'sim', value, asOf: NOW });
  return partial<UserVenue>({
    venue: { id: 'sim', displayName: 'Venue', kind: 'external-dex', sequencedDepth: false, proofLevel: 'simulator' },
    markets: async () =>
      asOf([
        partial<UserVenueMarket>({ symbol: 'BTC-USDC', kind: 'spot', baseAsset: 'BTC', quoteAsset: 'USDC' }),
        partial<UserVenueMarket>({
          symbol: 'BTC-PERP',
          kind: 'perpetual',
          baseAsset: 'BTC',
          quoteAsset: 'USDC',
          marginAccount: { known: false },
        }),
      ]),
    positions: async () => {
      if (opts.down) throw new VenueRefusalError({ code: 'venue_down', venueId: 'sim', detail: 'TEST venue down' });
      return asOf([
        {
          symbol: 'BTC-PERP',
          side: 'long',
          size: a('0.01'),
          entryPrice: a('90000'),
          markPrice: a('91000'),
          unrealisedPnl: a('10'),
          marginMode: 'cross',
          margin: a('300'),
          leverageBps: 30_000,
          liquidationPrice: { known: true, value: a('61000') },
        },
        {
          symbol: 'ETH-PERP',
          side: 'short',
          size: a('1'),
          entryPrice: a('3000'),
          markPrice: a('3000'),
          unrealisedPnl: a('0'),
          marginMode: 'cross',
          margin: a('100'),
          leverageBps: 30_000,
          liquidationPrice: { known: false },
        },
      ]);
    },
    fills: async (_acc, since) =>
      asOf(
        [
          fill('old', 'BTC-PERP', '2026-11-20T12:00:00Z', '1000'),
          fill('mon', 'BTC-PERP', '2026-11-24T09:00:00Z', '40'),
          fill('open', 'BTC-PERP', '2026-11-26T09:00:00Z', null),
          fill('today', 'BTC-PERP', '2026-11-27T08:00:00Z', '-5'),
          fill('spot', 'BTC-USDC', '2026-11-26T10:00:00Z', null, '9'),
        ].filter((f) => f.filledAt.getTime() >= since.getTime()),
      ),
    ...(opts.summary === false
      ? {}
      : {
          accountSummary: async () =>
            asOf({
              asset: 'USDC',
              equity: a('1200'),
              free: a('900'),
              usedMargin: a('1000'),
              maintenanceMargin: a('50'),
              marginRatio: { known: false },
            }),
        }),
  });
}

const store = partial<PreparedActionStore>({ ownerSignedAccounts: async () => [{ owner: OWNER, subAccount: null }] });

describe('venue.deskSnapshot', () => {
  it('reads positions, margin use, perpetual fills since the asked time and the week profit, every figure the venue’s', async () => {
    const snap = await readDeskSnapshot({
      venue: async () => venue(),
      store,
      input: { userId: 'u', since: '2026-11-25T00:00:00Z' },
      now: () => NOW,
    });
    expect(tradeDeskSnapshotSchema.parse(snap)).toEqual(snap);
    if (snap.state !== 'read') throw new Error('not read');
    expect(snap.test).toBe(true);
    expect(snap.weekStart).toBe('2026-11-23T00:00:00.000Z');
    expect(snap.accounts).toEqual([
      {
        owner: OWNER,
        subAccount: null,
        accountValue: '1200',
        marginUsed: '1000',
        marginUse: '83.33',
        unrealisedPnl: '10',
        positions: [
          {
            symbol: 'BTC-PERP',
            side: 'long',
            size: '0.01',
            entryPrice: '90000',
            markPrice: '91000',
            unrealisedPnl: '10',
            margin: '300',
            liquidationPrice: '61000',
          },
          {
            symbol: 'ETH-PERP',
            side: 'short',
            size: '1',
            entryPrice: '3000',
            markPrice: '3000',
            unrealisedPnl: '0',
            margin: '100',
            liquidationPrice: null,
          },
        ],
      },
    ]);
    // Since Wednesday: the opening fill only; the spot fill is never listed.
    expect(snap.fills.map((f) => f.fillId)).toEqual(['open', 'today']);
    expect(snap.fills[0]).toMatchObject({ realisedPnl: null, fee: '0.6', feeAsset: 'USDC' });
    // The week: Monday's close (40) and today's (-5) less three perpetual fills' fees (0.6 each); last week's is not counted.
    expect(snap.week).toEqual({ asset: 'USDC', realisedPnl: '35', fees: '1.8', profit: '33.2' });
    // Today, from 00:00 UTC: today's close only.
    expect(snap.dayStart).toBe('2026-11-27T00:00:00.000Z');
    expect(snap.today).toEqual({ asset: 'USDC', realisedPnl: '-5', fees: '0.6', profit: '-5.6' });
  });

  it('a venue that reads no margin summary gives a null margin use, never zero', async () => {
    const snap = await readDeskSnapshot({
      venue: async () => venue({ summary: false }),
      store,
      input: { userId: 'u', since: NOW.toISOString() },
      now: () => NOW,
    });
    if (snap.state !== 'read') throw new Error('not read');
    expect(snap.accounts[0]).toMatchObject({ accountValue: null, marginUse: null, marginUsed: '400' });
  });

  it('a venue that refuses the read is named, never read as no positions', async () => {
    const snap = await readDeskSnapshot({
      venue: async () => venue({ down: true }),
      store,
      input: { userId: 'u', since: NOW.toISOString() },
      now: () => NOW,
    });
    expect(snap).toEqual({ state: 'unreadable', venue: 'Venue', test: true });
    expect(tradeDeskSnapshotSchema.parse(snap)).toEqual(snap);
  });

  it('the door off answers off', async () => {
    expect(await readDeskSnapshot({ venue: null, store, input: { userId: 'u', since: NOW.toISOString() }, now: () => NOW })).toEqual({
      state: 'off',
    });
  });

  it('the week starts Monday 00:00 UTC, and margin use floors to two places', () => {
    expect(weekStartOf(new Date('2026-11-23T00:00:00Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(weekStartOf(new Date('2026-11-29T23:59:59Z')).toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(weekStartOf(new Date('2026-11-30T00:00:00Z')).toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect(marginUseOf(a('2'), a('3'))).toBe('66.66');
    expect(marginUseOf(a('80'), a('100'))).toBe('80');
    expect(marginUseOf(a('1'), a('0'))).toBeNull();
  });
});
