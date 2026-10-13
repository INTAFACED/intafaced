import { describe, expect, it } from 'vitest';
import { marketsFromJson } from './follow-store.js';

describe('marketsFromJson', () => {
  it('reads a jsonb array', () => {
    expect(marketsFromJson(['BTC/USDT', 'ETH/USDT'])).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('reads a row stored as a JSON string before the ::text::jsonb fix', () => {
    expect(marketsFromJson('["BTC/USDT","ETH/USDT"]')).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('refuses anything that is not a list', () => {
    expect(marketsFromJson('not json')).toEqual([]);
    expect(marketsFromJson('{"a":1}')).toEqual([]);
    expect(marketsFromJson(null)).toEqual([]);
  });
});
