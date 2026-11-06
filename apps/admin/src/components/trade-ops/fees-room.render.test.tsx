import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ok, refused } from '@/lib/trade-ops/outcome';
import type { FeesDeskView } from '@/lib/trade-ops/fees-calls';
import type { FeeVersionRow } from '@/lib/trade-ops/fees-versions-model';
import { FeesRoom } from './fees-room';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const AS_OF = '2026-11-06T10:00:00.000Z';
const row = (version: string, effectiveAt: string, maker: string, extra: Record<string, unknown> = {}): FeeVersionRow => ({
  version,
  effectiveAt,
  operatorId: 'a',
  approverId: 'b',
  reason: 'TEST version',
  createdAt: effectiveAt,
  schedule: {
    defaultPairGroup: 'all-others',
    pairGroups: { 'IFC/USDT': 'test-rebate' },
    rows: [
      { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null },
      { pairGroup: 'test-rebate', tierId: 'regular', zeroFee: false, makerBps: maker, takerBps: '10', makerRebateBps: '5', minFee: null },
    ],
    tierProgram: { thresholds: [{ tierId: 'test-vip-1', minVolume30d: '500' }], snapshotTimeUtc: '10:42' },
    ...extra,
  },
});
const HISTORY = [
  row('1', '2026-11-06T09:00:00.000Z', '1'),
  row('2', '2026-11-06T09:30:00.000Z', '0'),
  row('3', '2026-11-06T10:05:00.000Z', '0'),
];

const view = (over: Partial<FeesDeskView> = {}): FeesDeskView => ({
  fees: ok({ version: '3', history: HISTORY }, AS_OF),
  snapshots: ok(
    [
      {
        instant: '2026-11-06T09:42:00.000Z',
        scheduleVersion: 'v2',
        accounts: 7,
        aboveRegular: 2,
        countedVolume: '1500.5',
        completedAt: AS_OF,
      },
    ],
    AS_OF,
  ),
  convert: ok(
    {
      paused: false,
      assets: [
        { asset: 'BTC', maxPerConvert: { amount: '100000', asset: 'USDT' } },
        { asset: 'IFC', maxPerConvert: null },
      ],
      restricted: [],
      spreadBps: '20',
      quoteTtlMs: '15000',
      deskBounds: { convert: { minQty: '0.1', maxQty: '5' }, oneClickBuy: null },
    },
    AS_OF,
  ),
  sellQuotes: ok(
    [
      {
        quoteId: 'q-1',
        userId: 'u-1',
        symbol: 'BTC/USDT',
        inAsset: 'BTC',
        inAmount: '0.001',
        outAsset: 'USDT',
        outAmount: '63.872',
        avgPrice: '64000',
        spreadAmount: '0.128',
        spreadAsset: 'USDT',
        spreadBps: 20,
        lifecycle: 'open',
        createdAt: AS_OF,
      },
    ],
    AS_OF,
  ),
  onrampQuotes: ok(
    [
      {
        quoteId: 'f-1',
        userId: 'u-1',
        assetId: 'USDT',
        amount: '50',
        method: 'card',
        payAmount: '47',
        fee: '1',
        rate: '0.92',
        payCurrency: 'EUR',
        simulated: true,
        createdAt: AS_OF,
      },
    ],
    AS_OF,
  ),
  asOf: AS_OF,
  ...over,
});

const cells = (html: string, rowAttr: string) => {
  const tr = html.match(new RegExp(`<tr[^>]*${rowAttr}[^>]*>(.*?)</tr>`))?.[1] ?? '';
  return [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ''));
};

describe('Fees and convert room', () => {
  const html = renderToStaticMarkup(<FeesRoom initial={view()} />);

  it('shows each pair group by version with its state, time and exact rates', () => {
    expect(html).toContain('data-room="fees"');
    expect(cells(html, 'data-version="v2" data-tier="regular" data-state="current"')).toEqual(
      expect.arrayContaining(['Current', '2026-11-06 09:30:00 UTC', 'regular']),
    );
    expect(html).toMatch(/data-version="v3" data-tier="regular" data-state="scheduled"/);
    expect(html).toMatch(/data-version="v1" data-tier="regular" data-state="previous"/);
    expect(html).toContain('Markets: IFC/USDT');
    expect(html).toContain('test-vip-1 from 500 · snapshot 10:42 UTC');
  });

  it('starts the proposal from the latest version, with every rate and the programme editable', () => {
    expect(html).toContain('Starts from v3');
    expect(html).toContain('aria-label="Taker bps, test-rebate / regular"');
    expect(html).toContain('aria-label="Threshold (30-day volume), test-vip-1"');
    expect(html).toContain('aria-label="Snapshot time (UTC, HH:MM)"');
  });

  it('shows the snapshot row with its figures', () => {
    expect(cells(html, 'data-snapshot="2026-11-06T09:42:00.000Z"')).toEqual(['v2', '7', '2', '1500.5']);
  });

  it('lists the maker rebate tiers of the version in force, with no control in the list', () => {
    const rebates = html.match(/data-fees="rebates"(.*?)<\/table>/)?.[1] ?? '';
    expect(rebates).toContain('From the version in force: v2.');
    expect(cells(rebates, 'data-pair-group="test-rebate" data-tier="regular"')).toEqual([
      'test-rebate',
      'regular',
      '0.00% (0 bps)',
      '0.05% (5 bps)',
    ]);
    expect(cells(rebates, 'data-pair-group="all-others" data-tier="regular"')).toEqual([
      'all-others',
      'regular',
      '0.08% (8 bps)',
      'not set',
    ]);
    expect(rebates).not.toMatch(/<(input|button|select|textarea)/);
  });

  it('offers a notice only for a scheduled version, with its effective time', () => {
    expect(html).toContain('<option value="v3" selected="">v3</option>');
    expect(html).not.toContain('<option value="v2">');
    expect(html).toContain('data-fees="notice-effective">Takes effect 2026-11-06 10:05:00 UTC</span>');
  });

  it('reads Convert\'s state, limits and owner values, a blank one "not set"', () => {
    expect(html).toContain('Convert is open.');
    expect(cells(html, 'data-asset="BTC"')).toEqual(['BTC', '100000 USDT']);
    expect(cells(html, 'data-asset="IFC"')).toEqual(['IFC', 'not set']);
    expect(html).toMatch(/Size at the desk price, one-click buy<\/dt><dd[^>]*>not set<\/dd>/);
    expect(html).toMatch(/Spread on a quote<\/dt><dd[^>]*>0\.20% \(20 bps\)<\/dd>/);
    const open = view().convert;
    if (open.kind !== 'ok') throw new Error('the fixture reads');
    const paused = renderToStaticMarkup(<FeesRoom initial={view({ convert: ok({ ...open.data, paused: true }, AS_OF) })} />);
    expect(paused).toContain('Convert is paused for maintenance: every quote refuses trade.convert_disabled.');
  });

  it('reads sell quotes and fiat buy fees exactly, the stand-in prices labelled TEST', () => {
    expect(cells(html, 'data-quote="q-1"')).toEqual(['u-1', '0.001 BTC', '63.872 USDT', '64000', '0.128 USDT (20 bps)', 'open']);
    expect(cells(html, 'data-onramp-quote="f-1"')).toEqual(['u-1', '50 USDT', 'card', '47 EUR', '1 EUR', '0.92']);
    expect(html).toContain('TEST: these prices come from a stand-in, not a payment partner.');
  });

  it('says a read that failed in its own section and hides no other', () => {
    const failed = renderToStaticMarkup(
      <FeesRoom initial={view({ onrampQuotes: refused('bank.onramp_quotes_limit_unset', 'TEST refusal', 400, null, AS_OF) })} />,
    );
    expect(failed).toContain('The fiat buy fees could not be read');
    expect(failed).toContain('bank.onramp_quotes_limit_unset');
    expect(failed).toContain('data-quote="q-1"');
  });
});
