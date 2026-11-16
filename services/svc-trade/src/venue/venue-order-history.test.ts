import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import type { UserVenueOrder, UserVenueOrderRecord } from '@intafaced/venue-contracts';
import type { StoredVenueAction } from './prepared-action-store.js';
import { amendTrail, historyPage, parseHistoryQuery, VenueHistoryQueryError } from './venue-order-history.js';

const NOW = Date.parse('2026-11-16T08:00:00.000Z');
const cloid = (n: number) => `0x${String(n).padStart(32, '0')}`;
const order = (n: number, side: 'buy' | 'sell', status: UserVenueOrder['status']): UserVenueOrder => ({
  venueOrderId: String(n),
  venueClientOrderId: cloid(n),
  symbol: 'BTC-USDC',
  side,
  type: 'limit',
  timeInForce: 'GTC',
  price: parseAmount('40000'),
  amount: parseAmount('0.001'),
  filled: status === 'filled' ? parseAmount('0.001') : ZERO,
  remaining: status === 'filled' ? ZERO : parseAmount('0.001'),
  averagePrice: null,
  status,
  locked: ZERO,
  lockedAsset: 'USDC',
  reduceOnly: false,
});
/** 25 orders, newest first: every fifth a filled sell, the rest cancelled buys, one a minute apart. */
const history: UserVenueOrderRecord[] = Array.from({ length: 25 }, (_, i) => {
  const n = 25 - i;
  return { order: order(n, n % 5 === 0 ? 'sell' : 'buy', n % 5 === 0 ? 'filled' : 'canceled'), placedAt: new Date(NOW - i * 60_000) };
});
const read = { venueId: 'test-venue', value: history, asOf: new Date(NOW) };
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof VenueHistoryQueryError) return { code: err.code, words: err.message };
    throw err;
  }
  throw new Error('expected a refusal');
};

describe('venue order history (J-cex-spot-06 #1)', () => {
  it('pages newest first at the page size, without repeats, and says when it is the last page', () => {
    const first = historyPage(read, parseHistoryQuery({}));
    expect(first.orders).toHaveLength(20);
    expect(first.next).toBe(cloid(6));
    const second = historyPage(read, parseHistoryQuery({ before: first.next! }));
    expect(second.orders.map((r) => r.order.venueClientOrderId)).toEqual([5, 4, 3, 2, 1].map(cloid));
    expect(second.next).toBeNull();
    const all = [...first.orders, ...second.orders].map((r) => r.order.venueClientOrderId);
    expect(new Set(all).size).toBe(25);
  });

  it('filters by side, state, market and the time placed', () => {
    const ids = (q: Record<string, string>) => historyPage(read, parseHistoryQuery(q)).orders.map((r) => r.order.venueOrderId);
    expect(ids({ side: 'sell' })).toEqual(['25', '20', '15', '10', '5']);
    expect(ids({ status: 'filled', side: 'buy' })).toEqual([]);
    expect(ids({ symbol: 'ETH-USDC' })).toEqual([]);
    expect(ids({ from: new Date(NOW - 2 * 60_000).toISOString(), to: new Date(NOW).toISOString() })).toEqual(['24', '23']);
  });

  it('refuses a filter it cannot use in words, and a marker that names no order in this history', () => {
    expect(refusal(() => parseHistoryQuery({ side: 'bye' }))).toEqual({
      code: 'trade.invalid_filter',
      words: 'side “bye” isn’t a choice we know: buy or sell',
    });
    expect(refusal(() => parseHistoryQuery({ status: 'done' })).code).toBe('trade.invalid_filter');
    expect(refusal(() => parseHistoryQuery({ limit: '7' })).words).toBe('a page holds 20, 50, 100 orders, not “7”');
    expect(refusal(() => parseHistoryQuery({ from: 'yesterday' })).code).toBe('trade.invalid_filter');
    expect(refusal(() => parseHistoryQuery({ from: '2026-11-16T00:00:00Z', to: '2026-11-15T00:00:00Z' })).code).toBe(
      'trade.invalid_filter',
    );
    expect(refusal(() => historyPage(read, parseHistoryQuery({ before: cloid(99) }))).code).toBe('trade.invalid_cursor');
  });
});

describe('the amend trail (J-cex-spot-06 #10)', () => {
  const account = { venueId: 'test-venue', owner: '0x' + 'a'.repeat(40), subAccount: null };
  const row = (key: string, amount: string, at: number, outcome: StoredVenueAction['lastOutcome'], on = account): StoredVenueAction => ({
    userId: 'u1',
    businessKey: key,
    createdAt: new Date(at),
    // Only the account and the amend intent are read: the rest of a prepared action is left out of this fake.
    prepared: {
      account: on,
      intent: {
        kind: 'amend_order',
        symbol: 'BTC-USDC',
        venueClientOrderId: cloid(1),
        amount: parseAmount(amount),
        price: parseAmount('40000'),
      },
    } as StoredVenueAction['prepared'],
    signature: { digest: '0x', signature: '0x', signedBy: account.owner } as StoredVenueAction['signature'],
    lastOutcome: outcome,
  });
  const accepted = (at: number) => ({ definite: true as const, accepted: true as const, venueRef: '1', order: null, asOf: new Date(at) });

  it('lists each amendment the venue accepted, oldest first, at the venue’s time; never a refused, unanswered or other account’s one', () => {
    const rows = [
      row('amend:a:2', '0.0008', NOW, accepted(NOW + 2000)),
      row('amend:a:1', '0.0009', NOW - 5000, accepted(NOW - 4000)),
      row('amend:a:3', '0.0007', NOW, { definite: false, reason: 'timeout' }),
      row('amend:a:4', '0.0006', NOW, {
        definite: true,
        accepted: false,
        refusal: { venueId: 'test-venue', code: 'venue_rejected', detail: 'no' },
        asOf: new Date(NOW),
      }),
      row('amend:b:1', '0.0005', NOW, accepted(NOW), { ...account, owner: '0x' + 'b'.repeat(40) }),
    ];
    expect(amendTrail(rows, account, cloid(1)).map((a) => [a.amount, a.recordedAt.getTime()])).toEqual([
      [parseAmount('0.0009'), NOW - 4000],
      [parseAmount('0.0008'), NOW + 2000],
    ]);
    expect(amendTrail(rows, account, cloid(2))).toEqual([]);
  });
});
