import { describe, expect, it } from 'vitest';
import { pageRows } from './procedures.js';

describe('isolation list pages', () => {
  it('reads items from a page and throws when the shape is not a page', () => {
    expect(pageRows({ items: [{ id: 'a' }], nextCursor: null })).toEqual([{ id: 'a' }]);
    expect(pageRows({ items: [], nextCursor: 'cursor' })).toEqual([]);
    expect(() => pageRows([{ id: 'a' }])).toThrow(/not \{ items, nextCursor \}/);
    expect(() => pageRows({ items: [] })).toThrow(/not \{ items, nextCursor \}/);
    expect(() => pageRows(null)).toThrow(/not \{ items, nextCursor \}/);
  });
});
