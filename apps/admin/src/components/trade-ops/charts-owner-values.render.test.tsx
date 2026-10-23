import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_TEXT, type ChartOwnerValuesView } from '@/lib/trade-ops/charts-owner-values-model';
import { ChartOwnerValuesPanel } from './charts-owner-values-panel';

const blank = (over: Partial<ChartOwnerValuesView> = {}): ChartOwnerValuesView => ({
  canWrite: true,
  scalars: {
    version: null,
    values: { compareCap: null, chartCountLimit: null, drawingCap: null, brushPointCap: null, delayedBoundarySeconds: null },
    operatorId: null,
    reason: null,
    updatedAt: null,
  },
  dataClasses: [{ symbol: 'BTC/USDT', version: null, dataClass: null, operatorId: null, approverId: null, updatedAt: null }],
  ...over,
});

describe('charts settings page', () => {
  it('shows every count as Not set until it is set, and never a default number', () => {
    const html = renderToStaticMarkup(<ChartOwnerValuesPanel initial={blank()} />);
    expect(html).toContain('Owner counts');
    expect(html).toContain('Data class per market');
    expect((html.match(/Not set/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('Compare cap');
    expect(html).toContain('Delayed boundary (seconds)');
    expect(html).not.toContain(READ_ONLY_TEXT);
  });

  it('shows a set count as its number and the data class as its label', () => {
    const html = renderToStaticMarkup(
      <ChartOwnerValuesPanel
        initial={blank({
          scalars: {
            version: '2',
            values: { compareCap: 3, chartCountLimit: 4, drawingCap: 50, brushPointCap: 2000, delayedBoundarySeconds: 30 },
            operatorId: 'op',
            reason: 'TEST',
            updatedAt: '2026-10-22T09:00:00.000Z',
          },
          dataClasses: [{ symbol: 'BTC/USDT', version: '1', dataClass: 'real_time', operatorId: 'op', approverId: 'ap', updatedAt: null }],
        })}
      />,
    );
    expect(html).toContain('Real time');
    expect(html).toContain('>3<');
    expect(html).toContain('>2000<');
  });

  it('is read-only for a support reader: the page says so and every write control is disabled', () => {
    const html = renderToStaticMarkup(<ChartOwnerValuesPanel initial={blank({ canWrite: false })} />);
    expect(html).toContain(READ_ONLY_TEXT);
    // The button element that opens with the given label must carry the disabled attribute.
    const buttonBefore = (label: string) => {
      const at = html.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      return html.slice(html.lastIndexOf('<button', at), at);
    };
    expect(buttonBefore('Ask a second founder to approve')).toContain('disabled');
    expect(buttonBefore('>Save<')).toContain('disabled');
  });

  it('says plainly when no market is listed, rather than showing an empty table', () => {
    const html = renderToStaticMarkup(<ChartOwnerValuesPanel initial={blank({ dataClasses: [] })} />);
    expect(html).toContain('No markets are listed, so');
  });
});
