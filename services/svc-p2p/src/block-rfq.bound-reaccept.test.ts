import { describe, expect, it } from 'vitest';
import { acceptBlockQuote, type BlockQuote } from './block-rfq.js';

describe('F1585 re-accept of an already-bound quote after expiresAt', () => {
  it('returns the bound quote (idempotent) instead of throwing rfq_expired', () => {
    const bound = {
      quoteId: 'q1',
      makerId: 'maker',
      takerId: 'taker',
      side: 'buy',
      asset: 'USDT',
      fiatCurrency: 'EUR',
      size: '1000',
      price: '1.0',
      notional: '1000',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:10:00.000Z',
      lifecycle: 'bound',
      acceptedAt: '2026-01-01T00:05:00.000Z',
      fillPrice: '1.0',
      capacity: 'principal',
      firmness: 'firm',
      bookFill: false,
    } as unknown as BlockQuote;
    const out = acceptBlockQuote({ quote: bound, now: new Date('2026-01-01T01:00:00.000Z') });
    expect(out.lifecycle).toBe('bound');
  });
});
