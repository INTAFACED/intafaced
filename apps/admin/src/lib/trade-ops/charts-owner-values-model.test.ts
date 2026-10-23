import { describe, expect, it } from 'vitest';
import {
  parseChartOwnerValuesView,
  parseWholeNumberText,
  reasonReady,
  scalarText,
  dataClassText,
  typedText,
  type ChartOwnerValuesView,
} from './charts-owner-values-model';

const wire = (over: Record<string, unknown> = {}, scalarOver: Record<string, unknown> = {}) => ({
  canWrite: true,
  scalars: {
    version: null,
    values: {
      compareCap: null,
      chartCountLimit: null,
      drawingCap: null,
      brushPointCap: null,
      delayedBoundarySeconds: null,
      renderBudgetMs: null,
    },
    operatorId: null,
    reason: null,
    updatedAt: null,
    ...scalarOver,
  },
  dataClasses: [
    {
      symbol: 'BTC/USDT',
      version: null,
      dataClass: null,
      operatorId: null,
      approverId: null,
      updatedAt: null,
    },
  ],
  ...over,
});

describe('parseChartOwnerValuesView', () => {
  it('reads a blank view: every count not set, no version, no data class', () => {
    const view = parseChartOwnerValuesView(wire()) as ChartOwnerValuesView;
    expect(view.canWrite).toBe(true);
    expect(view.scalars.version).toBeNull();
    expect(Object.values(view.scalars.values).every((v) => v === null)).toBe(true);
    expect(view.dataClasses[0]).toMatchObject({ symbol: 'BTC/USDT', dataClass: null });
  });

  it('reads set counts and a set data class', () => {
    const view = parseChartOwnerValuesView(
      wire(
        {
          dataClasses: [
            {
              symbol: 'BTC/USDT',
              version: '2',
              dataClass: 'delayed',
              operatorId: 'o',
              approverId: 'a',
              updatedAt: '2026-10-22T09:00:00.000Z',
            },
          ],
        },
        {
          version: '3',
          values: {
            compareCap: 3,
            chartCountLimit: 4,
            drawingCap: 50,
            brushPointCap: 2000,
            delayedBoundarySeconds: 30,
            renderBudgetMs: 500,
          },
        },
      ),
    ) as ChartOwnerValuesView;
    expect(view.scalars.values).toEqual({
      compareCap: 3,
      chartCountLimit: 4,
      drawingCap: 50,
      brushPointCap: 2000,
      delayedBoundarySeconds: 30,
      renderBudgetMs: 500,
    });
    expect(view.dataClasses[0]).toMatchObject({ dataClass: 'delayed', version: '2', approverId: 'a' });
  });

  it('refuses a shape that is not the service view, rather than showing a guess', () => {
    expect(parseChartOwnerValuesView(null)).toBeNull();
    expect(parseChartOwnerValuesView(wire({ canWrite: 'yes' }))).toBeNull();
    expect(parseChartOwnerValuesView(wire({ scalars: undefined }))).toBeNull();
    expect(parseChartOwnerValuesView(wire({}, { values: { compareCap: '3' } }))).toBeNull();
    expect(parseChartOwnerValuesView(wire({}, { values: { compareCap: 2.5 } }))).toBeNull();
    expect(parseChartOwnerValuesView(wire({ dataClasses: [{ symbol: 'BTC/USDT', version: null, dataClass: 'live' }] }))).toBeNull();
    expect(parseChartOwnerValuesView(wire({ dataClasses: 'none' }))).toBeNull();
  });
});

describe('parseWholeNumberText', () => {
  it('blank clears the value', () => {
    expect(parseWholeNumberText('')).toEqual({ ok: true, value: null });
    expect(parseWholeNumberText('   ')).toEqual({ ok: true, value: null });
  });

  it('reads digits as a whole number, and refuses anything else with a plain sentence', () => {
    expect(parseWholeNumberText(' 50 ')).toEqual({ ok: true, value: 50 });
    for (const bad of ['2.5', '-3', '1e3', 'three', '12a']) {
      const out = parseWholeNumberText(bad);
      expect(out.ok).toBe(false);
    }
    expect(parseWholeNumberText('x')).toMatchObject({ ok: false, message: expect.stringContaining('whole number') });
  });

  it('does not hold a bound: the service decides whether 0 or 99999 is in range', () => {
    expect(parseWholeNumberText('0')).toEqual({ ok: true, value: 0 });
    expect(parseWholeNumberText('99999')).toEqual({ ok: true, value: 99999 });
  });

  it('refuses a number too large to store exactly', () => {
    expect(parseWholeNumberText('9007199254740993')).toMatchObject({ ok: false });
  });
});

describe('typed text and labels', () => {
  it('starts the form from the stored values: digits for a set count, empty for not set', () => {
    const text = typedText({
      compareCap: 3,
      chartCountLimit: null,
      drawingCap: null,
      brushPointCap: null,
      delayedBoundarySeconds: 30,
      renderBudgetMs: 500,
    });
    expect(text).toEqual({
      compareCap: '3',
      chartCountLimit: '',
      drawingCap: '',
      brushPointCap: '',
      delayedBoundarySeconds: '30',
      renderBudgetMs: '500',
    });
  });

  it('says "Not set" for a blank value and never a number for it', () => {
    expect(scalarText(null)).toBe('Not set');
    expect(scalarText(0)).toBe('0');
    expect(dataClassText(null)).toBe('Not set');
    expect(dataClassText('end_of_day')).toBe('End of day');
  });

  it('needs a reason of at least 12 characters before a write is offered', () => {
    expect(reasonReady('short')).toBe(false);
    expect(reasonReady('   too short  ')).toBe(false);
    expect(reasonReady('twelve chars!')).toBe(true);
  });
});
