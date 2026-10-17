/**
 * TEST quotes for the unit tests and the harness: one per stage of a quote's life. Every figure is illustrative and
 * the counterparty says TEST. None of it ever reaches the real walk.
 */
import type { RfqFill, RfqQuote } from '../rooms/api';

/** A fixed "now" so a countdown in a test or a screenshot never drifts. */
export const TEST_NOW = Date.parse('2026-10-17T10:00:00.000Z');

const base: RfqQuote = {
  quoteId: 'TEST-quote-open-0001',
  side: 'buy',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  qty: '0.5',
  midPrice: '60000',
  quotedPrice: '60120',
  midNotional: '30000',
  userNotional: '30060',
  spreadBps: 20,
  spreadNotional: '60',
  counterparty: 'TEST desk',
  counterpartyId: 'TEST-cp-1',
  createdAt: '2026-10-17T09:59:30.000Z',
  expiresAt: '2026-10-17T10:00:30.000Z',
  status: 'open',
  lifecycle: 'open',
  acceptedAt: null,
  fillPrice: null,
};

export const TEST_QUOTES = {
  open: base,
  bound: {
    ...base,
    quoteId: 'TEST-quote-bound-0002',
    status: 'bound',
    lifecycle: 'bound',
    acceptedAt: '2026-10-17T09:59:50.000Z',
    fillPrice: '60120',
  },
  settled: {
    ...base,
    quoteId: 'TEST-quote-settled-0003',
    status: 'settled',
    lifecycle: 'settled',
    acceptedAt: '2026-10-17T09:58:10.000Z',
    fillPrice: '60120',
  },
  expired: { ...base, quoteId: 'TEST-quote-expired-0004', status: 'expired', lifecycle: 'expired' },
  /** Sell side, so the "you receive" wording and the reversed spread sign are covered. */
  sell: {
    ...base,
    quoteId: 'TEST-quote-sell-0005',
    side: 'sell',
    quotedPrice: '59880',
    userNotional: '29940',
    spreadNotional: '60',
  },
} as const satisfies Record<string, RfqQuote>;

export const TEST_FILL: RfqFill = {
  quoteId: TEST_QUOTES.settled.quoteId,
  side: 'buy',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  qty: '0.5',
  fillPrice: '60120',
  fillNotional: '30060',
  spreadBps: 20,
  counterparty: 'TEST desk',
  counterpartyId: 'TEST-cp-1',
  acceptedAt: '2026-10-17T09:58:10.000Z',
  fillId: 'TEST-fill-0001',
  takerOrderId: 'TEST-order-t1',
  makerOrderId: 'TEST-order-m1',
};
