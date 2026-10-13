import { describe, expect, it } from 'vitest';
import { ABOUT, aboutFor } from './about';

describe('About copy (UI-SPEC 5.5)', () => {
  it('exists for BTC, ETH, USDT and USDC only: IFC and anything else has no section', () => {
    expect(Object.keys(ABOUT).sort()).toEqual(['BTC', 'ETH', 'USDC', 'USDT']);
    expect(aboutFor('IFC')).toBeNull();
    expect(aboutFor('SOL')).toBeNull();
  });
  it('is two or three plain sentences', () => {
    for (const [asset, paragraphs] of Object.entries(ABOUT)) {
      expect(paragraphs.length, asset).toBeGreaterThanOrEqual(2);
      expect(paragraphs.length, asset).toBeLessThanOrEqual(3);
      for (const text of paragraphs) expect(text.endsWith('.'), `${asset}: ${text}`).toBe(true);
    }
  });
  it('makes no price claim, ranking or internal term', () => {
    const all = Object.values(ABOUT).flat().join(' ');
    expect(all).not.toMatch(/\$\s?\d|\d+%|all-time|market cap|rank|best|safe|guarantee|invest(?:ment)? advice/i);
    expect(all).not.toMatch(/ledger|room|door|lifecycle|fixture|tier/i);
  });
});
