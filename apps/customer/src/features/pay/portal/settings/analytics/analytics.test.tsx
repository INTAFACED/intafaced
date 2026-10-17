import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { parsePortalRoute } from '../../routes';
import { AnalyticsView } from './Analytics';
import { useAnalyticsState } from './Controls';
import { FeesView } from './Fees';
import {
  assetsOf,
  barsFor,
  busiest,
  feeTotals,
  periodsWithSales,
  readAll,
  sumByAsset,
  totalCount,
  windowFor,
  MAX_PAGES,
  type Point,
} from './model';

// TEST DATA only.
const NOW = Date.parse('2026-10-17T04:00:00.000Z');
const fresh = { asOf: '2026-10-17T03:58:30.000Z', lagSeconds: 90 };
const points: Point[] = [
  { period: '2026-10-16', assetCode: 'USDT', volume: '300.10', count: 3 },
  { period: '2026-10-15', assetCode: 'USDT', volume: '0.20', count: 1 },
  { period: '2026-10-15', assetCode: 'USD', volume: '85.50', count: 2 },
];
type Loaded = Parameters<typeof AnalyticsView>[0]['resource'];
const loaded = (over: Partial<NonNullable<Extract<Loaded, { status: 'ready' }>['data']>> = {}): Loaded => ({
  status: 'ready',
  data: { points, complete: true, freshness: fresh, source: 'analytics', ...over },
});
function Volume({ resource, test = false }: { resource: Loaded; test?: boolean }) {
  const state = useAnalyticsState(NOW);
  return <AnalyticsView state={state} resource={resource} reload={() => {}} test={test} />;
}
function FeesPage({ resource }: { resource: Parameters<typeof FeesView>[0]['resource'] }) {
  const state = useAnalyticsState(NOW);
  return <FeesView state={state} resource={resource} reload={() => {}} test={false} />;
}
const feeRows = [
  { period: '2026-10-16', assetCode: 'USDT', gross: '300.00', fees: '8.70', net: '291.30', refunded: '0' },
  { period: '2026-10-15', assetCode: 'USDT', gross: '100.00', fees: '2.90', net: '97.10', refunded: '10.00' },
  { period: '2026-10-15', assetCode: 'USD', gross: '50.00', fees: '1.45', net: '48.55', refunded: '0' },
];

describe('the period', () => {
  it('means whole UTC days with an exclusive end', () => {
    expect(windowFor('today', NOW, { from: '', to: '' })).toEqual({ from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' });
    expect(windowFor('7d', NOW, { from: '', to: '' })).toEqual({ from: '2026-10-11T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' });
    expect(windowFor('30d', NOW, { from: '', to: '' })?.from).toBe('2026-09-18T00:00:00.000Z');
  });
  it('takes custom days as typed, the last day included, and refuses an incomplete or backwards pair', () => {
    expect(windowFor('custom', NOW, { from: '2026-10-01', to: '2026-10-07' })).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
    });
    expect(windowFor('custom', NOW, { from: '2026-10-08', to: '2026-10-07' })).toBeNull();
    expect(windowFor('custom', NOW, { from: '2026-10-01', to: '' })).toBeNull();
  });
});

describe('totals', () => {
  it('adds exactly, one asset at a time, never across assets', () => {
    expect(sumByAsset(points, (p) => p.volume)).toEqual([
      { assetCode: 'USD', total: '85.5' },
      { assetCode: 'USDT', total: '300.3' },
    ]);
    expect(feeTotals(feeRows).fees).toEqual([
      { assetCode: 'USD', total: '1.45' },
      { assetCode: 'USDT', total: '11.6' },
    ]);
  });
  it('counts captures, finds the busiest day and days with sales', () => {
    expect(totalCount(points)).toBe(6);
    expect(busiest(points)).toEqual({ period: '2026-10-16', count: 3 });
    expect(periodsWithSales(points)).toBe(2);
    expect(assetsOf(points)).toEqual(['USD', 'USDT']);
  });
  it('gives no count where the figures come from daily totals', () => {
    const daily: Point[] = points.map((p) => ({ ...p, count: null }));
    expect(totalCount(daily)).toBeNull();
    expect(busiest(daily)).toBeNull();
  });
  it('draws bars oldest first, to scale, with a visible bar for any non-zero amount', () => {
    const bars = barsFor(points, 'USDT', 100);
    expect(bars.map((b) => b.period)).toEqual(['2026-10-15', '2026-10-16']);
    expect(bars[1]!.h).toBe(100);
    expect(bars[0]!.h).toBeGreaterThanOrEqual(1);
  });
});

describe('reading every page', () => {
  const page = (n: number, next: string | null) => ({ ok: true as const, data: { items: [n], nextCursor: next, freshness: fresh } });
  it('follows the service cursor to the end and says it is complete', async () => {
    const seen: Array<string | undefined> = [];
    const result = await readAll<number>(async (cursor) => {
      seen.push(cursor);
      return cursor === undefined ? page(1, 'a') : cursor === 'a' ? page(2, 'b') : page(3, null);
    });
    expect(seen).toEqual([undefined, 'a', 'b']);
    expect(result.ok && result.data).toMatchObject({ items: [1, 2, 3], complete: true });
  });
  it('stops at a ceiling and says it is cut short, so no total is shown', async () => {
    let calls = 0;
    const result = await readAll<number>(async () => page(++calls, 'more'));
    expect(calls).toBe(MAX_PAGES);
    expect(result.ok && result.data.complete).toBe(false);
  });
  it('passes a refusal straight through', async () => {
    const result = await readAll<number>(async () => ({ ok: false, reason: 'forbidden', message: 'no', code: '' }) as never);
    expect(result.ok).toBe(false);
  });
});

describe('volume page', () => {
  it('shows the as-of time, exact totals per asset and a tile that opens the payment list for the same days', () => {
    const out = renderToString(<Volume resource={loaded()} />);
    expect(out).toContain('Updated');
    expect(out).toContain('300.3');
    expect(out).toContain('85.5');
    expect(out).toContain('/pay/payments?date=custom&amp;from=');
    expect(out).toContain('Captured volume');
  });
  it('gives each asset its own chart and a table of exact amounts as the fallback', () => {
    const out = renderToString(<Volume resource={loaded()} />);
    expect(out).toContain('Captured USDT');
    expect(out).toContain('Captured USD');
    expect(out).toContain('role="img"');
    expect(out).toContain('By period');
    expect(out).toContain('300.10');
  });
  it('labels test money', () => {
    expect(renderToString(<Volume resource={loaded()} test />)).toContain('TEST');
    expect(renderToString(<Volume resource={loaded()} />)).not.toContain('>TEST<');
  });
  it('leaves totals out, and says why, when the period has more than can be shown', () => {
    const out = renderToString(<Volume resource={loaded({ complete: false })} />);
    expect(out).toContain('totals are left out');
    expect(out).toContain('Shown once the period fits');
  });
  it('says counts are missing, and does not invent them, when only daily totals exist', () => {
    const out = renderToString(<Volume resource={loaded({ source: 'daily', points: points.map((p) => ({ ...p, count: null })) })} />);
    expect(out).toContain('Counts are not in the daily totals');
    expect(out).toContain('no payment counts');
  });
  it('explains an empty period instead of showing zeros', () => {
    const out = renderToString(<Volume resource={loaded({ points: [] })} />);
    expect(out).toContain('No captured payments in this period');
    expect(out).not.toContain('pp-kpi');
  });
  it('says what is wrong with a custom period that is not finished', () => {
    expect(renderToString(<Volume resource={null} />)).toContain('Pick a first and last day');
  });
  it('shows the refusal in words when the read fails', () => {
    const out = renderToString(
      <Volume resource={{ status: 'failed', failure: { ok: false, reason: 'forbidden', message: 'x', code: '' } as never }} />,
    );
    expect(out).not.toContain('pp-kpi');
    expect(out).toMatch(/not allowed|allowed/i);
  });
});

describe('fees page', () => {
  const data = (over = {}) => ({ points: feeRows, complete: true, freshness: fresh, effectiveRate: null, conversionCost: null, ...over });
  it('shows gross, fees, net and refunds as exact sums per asset', () => {
    const out = renderToString(<FeesPage resource={{ status: 'ready', data: data() }} />);
    for (const word of ['Gross', 'Fees', 'Net', 'Refunded']) expect(out).toContain(word);
    expect(out).toContain('11.6');
    expect(out).toContain('291.30');
  });
  it('works out the effective rate per asset as fees divided by gross, from the sums on the page', () => {
    const out = renderToString(<FeesPage resource={{ status: 'ready', data: data() }} />);
    expect(out).toContain('Effective fee rate by asset');
    expect(out.match(/2\.90%/g)).toHaveLength(2); // 1.45 / 50 (USD) and 11.60 / 400 (USDT), never mixed
    expect(out).not.toContain('No rate shown yet');
  });
  it('names what is missing when the figures are cut short, instead of a partial rate', () => {
    const out = renderToString(<FeesPage resource={{ status: 'ready', data: data({ complete: false }) }} />);
    expect(out).toContain('No rate shown yet');
    expect(out).not.toMatch(/\d\.\d+%/);
  });
  it('shows a rate only when the service sends one', () => {
    expect(renderToString(<FeesPage resource={{ status: 'ready', data: data({ effectiveRate: '2.9%' }) }} />)).toContain('2.9%');
  });
  it('names why the whole page is off when the fee summary is not switched on', () => {
    const out = renderToString(
      <FeesPage
        resource={{
          status: 'failed',
          failure: { ok: false, reason: 'not_mounted', message: 'pay.not_built', code: 'pay.not_built' } as never,
        }}
      />,
    );
    expect(out).toContain('Fee analytics are not switched on yet');
    expect(out).toContain('Not connected yet');
  });
});

describe('addresses', () => {
  it('routes volume and fees', () => {
    expect(parsePortalRoute('/pay/analytics')?.room).toBe('analytics');
    expect(parsePortalRoute('/pay/analytics/fees')?.room).toBe('analytics-fees');
  });
});
