// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { CHART_SETTING_KEY, currentChartInterval, storeChartInterval } from './chart-setting';

describe('the desk chart interval kept for a desk about to open', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the interval and the chart style already chosen', () => {
    localStorage.setItem(CHART_SETTING_KEY, JSON.stringify({ interval: '15m', mode: 'line' }));
    storeChartInterval('4h');
    expect(JSON.parse(localStorage.getItem(CHART_SETTING_KEY) ?? 'null')).toEqual({ interval: '4h', mode: 'line' });
    expect(currentChartInterval()).toBe('4h');
  });

  it('starts from the default when nothing valid is stored', () => {
    localStorage.setItem(CHART_SETTING_KEY, '{"interval":"9m"}');
    storeChartInterval('1w');
    expect(JSON.parse(localStorage.getItem(CHART_SETTING_KEY) ?? 'null')).toEqual({ interval: '1w', mode: 'candles' });
  });
});
