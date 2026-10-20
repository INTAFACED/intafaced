import { describe, expect, it } from 'vitest';
import { filterHistory, isFiltering, NO_HISTORY_FILTER, type HistoryFilter } from './history-filter';

type Row = Parameters<
  typeof filterHistory<{ side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop_limit'; status: 'closed' | 'canceled' }>
>[0][number];
const rows: Row[] = [
  { side: 'buy', type: 'limit', status: 'closed' },
  { side: 'sell', type: 'limit', status: 'canceled' },
  { side: 'sell', type: 'stop_limit', status: 'canceled' },
  { side: 'buy', type: 'market', status: 'closed' },
];

const pick = (patch: Partial<HistoryFilter>) => filterHistory(rows as never, { ...NO_HISTORY_FILTER, ...patch });

describe('order history filter', () => {
  it('keeps every row, in order, when nothing is picked', () => {
    expect(pick({})).toEqual(rows);
    expect(isFiltering(NO_HISTORY_FILTER)).toBe(false);
  });

  it('narrows by side, type and status, and by all three together', () => {
    expect(pick({ side: 'sell' })).toHaveLength(2);
    expect(pick({ type: 'stop_limit' })).toEqual([rows[2]]);
    expect(pick({ status: 'closed' })).toEqual([rows[0], rows[3]]);
    expect(pick({ side: 'sell', type: 'limit', status: 'canceled' })).toEqual([rows[1]]);
    expect(isFiltering({ ...NO_HISTORY_FILTER, side: 'buy' })).toBe(true);
  });

  it('a pick that matches nothing is an empty list', () => {
    expect(pick({ side: 'buy', status: 'canceled' })).toEqual([]);
  });
});
