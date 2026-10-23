import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { MemoryLedger } from '@intafaced/ledger-client';
import { CopyService } from '../controls/test-admission.js';
import { principalFor } from '../spot/testing.js';
import { CopyError } from './errors.js';
import { memoryLeaderDirectory } from './leader-directory.js';
import { normaliseLeaderSearch } from './leader-listing.js';
import {
  decodeLeaderTradesCursor,
  pageLeaderTrades,
  pairLeaderTrades,
  parseCopyMetricDefinitionsJson,
  presentLeaderProfile,
  type LeaderOrderFills,
} from './leader-profile.js';

const OP = '00000000-0000-4000-8000-0000000000aa';
const READER = '00000000-0000-4000-8000-0000000000b1';
const operator = () => principalFor(OP, ['admin:write']);
const reader = () => principalFor(READER, ['trade:read']);

function order(side: 'buy' | 'sell', qty: string, quote: string, minute: number, extra: Partial<LeaderOrderFills> = {}): LeaderOrderFills {
  const at = new Date(Date.UTC(2026, 9, 23, 0, minute));
  return {
    symbol: 'BTC/USDT',
    side,
    qty: parseAmount(qty),
    quote: parseAmount(quote),
    firstAt: at,
    lastAt: at,
    takeProfit: null,
    stopLoss: null,
    ...extra,
  };
}

function copyWithDirectory(definitions = parseCopyMetricDefinitionsJson('')) {
  let tick = Date.parse('2026-10-23T00:00:00.000Z');
  const now = () => new Date((tick += 1000));
  const directory = memoryLeaderDirectory({
    now,
    feeShareLaw: { published: false },
    countActive: async () => 0,
  });
  const copy = new CopyService(new MemoryLedger(), { directory, now, metricDefinitions: definitions });
  const list = async (leaderUserId: string, displayName: string, marketMode?: string, state = 'listed') =>
    copy.upsertListing(operator(), {
      clientRequestId: `list:${leaderUserId}:${state}`,
      leaderUserId,
      displayName,
      recordKind: 'self_reported',
      state,
      ...(marketMode ? { marketMode } : {}),
    });
  return { copy, list };
}

describe('lead trades are paired first-in first-out from fills', () => {
  it('closes a buy with a later sell and works out entry, close and ROI from the fills', () => {
    const [row] = pairLeaderTrades([order('buy', '2', '200', 1), order('sell', '2', '220', 5)]);
    expect(row).toMatchObject({
      symbol: 'BTC/USDT',
      state: 'closed',
      entryPrice: '100',
      qty: '2',
      margin: '200',
      closePrice: '110',
      closedQty: '2',
      roiPercent: '10',
    });
    expect(row?.closedAt).toBe('2026-10-23T00:05:00.000Z');
  });

  it('keeps a part-closed buy open, with the close price of the part sold', () => {
    const rows = pairLeaderTrades([order('buy', '4', '400', 1), order('sell', '1', '90', 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'open', closedAt: null, closePrice: '90', closedQty: '1', roiPercent: '-10' });
  });

  it('spreads one sell over two buys in order, and the slices add up to the sell exactly', () => {
    const rows = pairLeaderTrades([
      order('buy', '1', '100', 1),
      order('buy', '1', '200', 2),
      order('sell', '1.5', '300.000000000000000001', 3),
    ]);
    // Newest first: the second buy is half closed, the first fully.
    expect(rows.map((r) => r.state)).toEqual(['open', 'closed']);
    const total = rows.reduce((sum, r) => sum + parseAmount(r.closePrice!) * parseAmount(r.closedQty), 0n) / 10n ** 18n;
    expect(total <= parseAmount('300.000000000000000001')).toBe(true);
    expect(rows[1]).toMatchObject({ entryPrice: '100', closePrice: '200', roiPercent: '100' });
  });

  it('shows a sell with no buy in the record as a closed row with no entry, and never invents one', () => {
    const [row] = pairLeaderTrades([order('sell', '1', '50', 1)]);
    expect(row).toMatchObject({ state: 'closed', entryPrice: null, margin: null, roiPercent: null, closePrice: '50' });
  });

  it('pairs only within one market', () => {
    const rows = pairLeaderTrades([order('buy', '1', '100', 1), order('sell', '1', '120', 2, { symbol: 'ETH/USDT' })]);
    expect(rows.find((r) => r.symbol === 'BTC/USDT')).toMatchObject({ state: 'open', closedQty: '0' });
    expect(rows.find((r) => r.symbol === 'ETH/USDT')).toMatchObject({ entryPrice: null });
  });

  it('carries the entry bracket as TP and SL', () => {
    const [row] = pairLeaderTrades([order('buy', '1', '100', 1, { takeProfit: parseAmount('130'), stopLoss: parseAmount('90') })]);
    expect(row).toMatchObject({ takeProfit: '130', stopLoss: '90' });
  });

  it('pages by offset and refuses a cursor that is not one', () => {
    const rows = pairLeaderTrades([1, 2, 3].map((m) => order('buy', '1', '100', m)));
    expect(pageLeaderTrades(rows, 0, 2)).toMatchObject({ nextCursor: '2' });
    expect(pageLeaderTrades(rows, 2, 2)).toMatchObject({ nextCursor: null });
    expect(() => decodeLeaderTradesCursor('abc')).toThrow(CopyError);
  });
});

describe('lead page metrics', () => {
  const definitions = parseCopyMetricDefinitionsJson(
    JSON.stringify({
      published: true,
      version: 'TEST-1',
      definitions: { publishedReturn: 'Return over the window.', maximumDrawdown: 'Largest fall.' },
    }),
  );

  it('shows a metric only with the owner definition; win rate and Sharpe read not set, never a number', async () => {
    const { copy, list } = copyWithDirectory(definitions);
    const listed = await list('00000000-0000-4000-8000-0000000000c1', 'Alpha');
    const profile = await copy.leaderProfile(reader(), { leaderRef: listed.leaderRef });
    expect(profile.definitionsVersion).toBe('TEST-1');
    expect(profile.metrics.map((m) => [m.key, m.reason])).toEqual([
      ['publishedReturn', 'no_published_record'],
      ['maximumDrawdown', 'no_published_record'],
      ['winRate', 'definition_unpublished'],
      ['sharpeRatio', 'definition_unpublished'],
    ]);
    expect(profile.metrics.every((m) => m.value === null)).toBe(true);
  });

  it('with no definitions published, every metric is not set even when the listing has a figure', () => {
    const profile = presentLeaderProfile(
      {
        publishedReturn: { value: '12.5', reason: null },
        maximumDrawdown: { value: '3', reason: null },
      } as never,
      'listed',
      parseCopyMetricDefinitionsJson(''),
    );
    expect(profile.metrics.every((m) => m.reason === 'definition_unpublished' && m.value === null)).toBe(true);
  });

  it('refuses a definition list that is not valid instead of showing a made-up meaning', () => {
    expect(() => parseCopyMetricDefinitionsJson('{"published":true,"version":"1","definitions":{"roi":"x"}}')).toThrow(/unknown metric/);
    expect(() => parseCopyMetricDefinitionsJson('{"published":true,"version":"","definitions":{}}')).toThrow(/version/);
    expect(() => parseCopyMetricDefinitionsJson('{')).toThrow(/JSON/);
  });

  it('a leader who is not listed has no page', async () => {
    const { copy, list } = copyWithDirectory();
    const unlisted = await list('00000000-0000-4000-8000-0000000000c2', 'Hidden', undefined, 'unlisted');
    await expect(copy.leaderProfile(reader(), { leaderRef: unlisted.leaderRef })).rejects.toMatchObject({
      code: 'trade.copy_leader_not_found',
    });
    await expect(copy.leaderProfile(reader(), { leaderRef: 'no-such-ref' })).rejects.toMatchObject({ code: 'trade.copy_leader_not_found' });
    await expect(copy.leaderTrades(reader(), { leaderRef: unlisted.leaderRef, limit: 10 })).rejects.toMatchObject({
      code: 'trade.copy_leader_not_found',
    });
  });

  it('refuses a trades read with no page size before it reads anything', async () => {
    const { copy, list } = copyWithDirectory();
    const listed = await list('00000000-0000-4000-8000-0000000000c3', 'Gamma');
    await expect(copy.leaderTrades(reader(), { leaderRef: listed.leaderRef })).rejects.toMatchObject({
      code: 'trade.copy_leader_trades_limit_unset',
    });
  });
});

describe('the directory filters on the server', () => {
  it('lists one market mode, matches names case-insensitively, and lists by listed time only', async () => {
    const { copy, list } = copyWithDirectory();
    await list('00000000-0000-4000-8000-0000000000d1', 'Abby Spot');
    await list('00000000-0000-4000-8000-0000000000d2', 'Cab Futures', 'futures');
    await list('00000000-0000-4000-8000-0000000000d3', 'Zed Futures', 'futures');
    await list('00000000-0000-4000-8000-0000000000d4', 'Bot Runner', 'bot');

    const futures = await copy.listLeaders(reader(), { limit: 50, marketMode: 'futures' });
    expect(futures.leaders.map((l) => l.displayName)).toEqual(['Cab Futures', 'Zed Futures']);
    expect(futures.leaders.every((l) => l.marketMode === 'futures')).toBe(true);

    const search = await copy.listLeaders(reader(), { limit: 50, q: 'AB' });
    expect(search.leaders.map((l) => l.displayName)).toEqual(['Abby Spot', 'Cab Futures']);

    const both = await copy.listLeaders(reader(), { limit: 50, marketMode: 'futures', q: 'zed' });
    expect(both.leaders.map((l) => l.displayName)).toEqual(['Zed Futures']);

    const all = await copy.listLeaders(reader(), { limit: 50 });
    expect(all.leaders.map((l) => l.marketMode)).toEqual(['spot', 'futures', 'futures', 'bot']);
  });

  it('refuses a ranked category or the trending row by name', async () => {
    const { copy } = copyWithDirectory();
    await expect(copy.listLeaders(reader(), { limit: 50, category: 'top_roi' })).rejects.toMatchObject({
      code: 'trade.copy_ranking_forbidden',
    });
    await expect(copy.listLeaders(reader(), { limit: 50, trending: true })).rejects.toMatchObject({ code: 'trade.copy_ranking_forbidden' });
  });

  it('refuses an unknown mode and an over-long search instead of listing everyone', () => {
    expect(() => normaliseLeaderSearch({ marketMode: 'options' })).toThrow(
      expect.objectContaining({ code: 'trade.copy_leader_mode_invalid' }),
    );
    expect(() => normaliseLeaderSearch({ q: 'x'.repeat(81) })).toThrow(
      expect.objectContaining({ code: 'trade.copy_leader_search_invalid' }),
    );
    expect(normaliseLeaderSearch({ q: '   ' })).toEqual({ marketMode: null, nameLike: null });
  });

  it('an operator edit without a mode keeps the stored one', async () => {
    const { copy, list } = copyWithDirectory();
    await list('00000000-0000-4000-8000-0000000000e1', 'Keeps Mode', 'signal');
    await copy.upsertListing(operator(), {
      clientRequestId: 'edit:e1',
      leaderUserId: '00000000-0000-4000-8000-0000000000e1',
      displayName: 'Keeps Mode Renamed',
      recordKind: 'self_reported',
      state: 'listed',
    });
    const page = await copy.listLeaders(reader(), { limit: 50, marketMode: 'signal' });
    expect(page.leaders.map((l) => l.displayName)).toEqual(['Keeps Mode Renamed']);
  });
});
