/**
 * Ledger history pages and the statement's ledger range walk.
 *
 * Promise: every line posted in [from, to) is in the statement, oldest first, each with its ledger reference; a range
 * with more lines than a statement carries refuses; a line the ledger answers malformed is refused, never shown.
 * Break: the walk stops before the range's oldest line; a line from outside the range rides along; a debit reads as
 * money out; a ledger failure reads as an empty history.
 */
import { describe, expect, it } from 'vitest';
import {
  ledgerLinesInRange,
  LedgerRangeTooLargeError,
  presentLedgerLine,
  readLine,
  type LedgerLine,
  type LedgerPages,
} from './ledger-history.js';

const USER = '11111111-1111-4111-8111-111111111111';

function line(id: number, at: string, over: Partial<LedgerLine> = {}): LedgerLine {
  return {
    entryId: String(id),
    txId: `tx-${id}`,
    module: 'trade',
    reason: 'trade.fill',
    direction: 'debit',
    amount: '1',
    postedAt: new Date(at),
    assetId: 'USDT',
    orderId: null,
    ...over,
  };
}

/** A ledger of lines, paged newest first by entry id like svc-ledger's historyPage. */
function pager(lines: LedgerLine[], seen: Array<{ limit: number; cursor?: string }> = []): LedgerPages {
  const newest = [...lines].sort((a, b) => Number(b.entryId) - Number(a.entryId));
  return {
    async page(request) {
      seen.push({ limit: request.limit, ...(request.cursor ? { cursor: request.cursor } : {}) });
      expect(request.userId).toBe(USER);
      const start = request.cursor === undefined ? 0 : newest.findIndex((l) => Number(l.entryId) < Number(request.cursor));
      const slice = start < 0 ? [] : newest.slice(start, start + 2);
      const last = slice[slice.length - 1];
      const more = start >= 0 && start + 2 < newest.length;
      return { entries: slice, nextCursor: more && last ? last.entryId : null };
    },
  };
}

const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') };

describe('ledgerLinesInRange', () => {
  it('returns exactly the lines posted in [from, to), oldest first, walking back across pages', async () => {
    const lines = [
      line(1, '2026-09-30T23:59:59Z'),
      line(2, '2026-10-01T00:00:00Z'),
      line(3, '2026-10-01T10:00:00Z'),
      line(4, '2026-10-01T23:59:59.999Z'),
      line(5, '2026-10-02T00:00:00Z'),
      line(6, '2026-10-03T00:00:00Z'),
    ];
    const got = await ledgerLinesInRange(pager(lines), USER, range, 100);
    expect(got.map((l) => l.entryId)).toEqual(['2', '3', '4']);
  });

  it('reads one page past the start, so a line stamped out of sequence near the boundary is kept', async () => {
    // Entry 3 was posted after entry 2 but stamped a moment before `from`; entry 2, in the range, is on the next page.
    const lines = [
      line(1, '2026-09-30T00:00:00Z'),
      line(2, '2026-10-01T00:00:01Z'),
      line(3, '2026-09-30T23:59:59Z'),
      line(4, '2026-10-01T00:00:02Z'),
    ];
    const seen: Array<{ limit: number; cursor?: string }> = [];
    const got = await ledgerLinesInRange(pager(lines, seen), USER, range, 100);
    expect(got.map((l) => l.entryId)).toEqual(['2', '4']);
    expect(seen).toEqual([{ limit: 200 }, { limit: 200, cursor: '3' }]);
  });

  it('refuses a range with more lines than a statement carries, rather than cutting it short', async () => {
    const lines = [line(1, '2026-10-01T01:00:00Z'), line(2, '2026-10-01T02:00:00Z'), line(3, '2026-10-01T03:00:00Z')];
    await expect(ledgerLinesInRange(pager(lines), USER, range, 2)).rejects.toBeInstanceOf(LedgerRangeTooLargeError);
    await expect(ledgerLinesInRange(pager(lines), USER, range, 3)).resolves.toHaveLength(3);
  });

  it('passes a ledger failure on: an unreachable ledger is never an empty history', async () => {
    const down: LedgerPages = {
      async page() {
        throw new Error('svc-ledger unreachable');
      },
    };
    await expect(ledgerLinesInRange(down, USER, range, 10)).rejects.toThrow('svc-ledger unreachable');
  });
});

describe('ledger lines on the wire', () => {
  const wire = {
    txId: 'tx-9',
    module: 'trade',
    reason: 'order.hold',
    direction: 'credit' as const,
    amount: '12.50',
    postedAt: '2026-10-01T10:00:00.000Z',
    assetId: 'USDT',
    entryId: '9',
    orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };

  it('a debit to the person’s account is money in, a credit money out; each line keeps its ledger references', () => {
    const out = presentLedgerLine(readLine(wire));
    expect(out).toEqual({
      id: '9',
      referenceId: 'tx-9',
      timestamp: Date.parse('2026-10-01T10:00:00.000Z'),
      datetime: '2026-10-01T10:00:00.000Z',
      currency: 'USDT',
      direction: 'out',
      amount: '12.5',
      type: 'order.hold',
      module: 'trade',
      orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(presentLedgerLine(readLine({ ...wire, direction: 'debit' })).direction).toBe('in');
    expect(presentLedgerLine(readLine({ ...wire, orderId: null })).orderId).toBeNull();
  });

  it('refuses a line with no entry id, a malformed amount or no posting time', () => {
    expect(() => readLine({ ...wire, entryId: undefined })).toThrow('no entry id');
    expect(() => readLine({ ...wire, amount: '1e3' })).toThrow();
    expect(() => readLine({ ...wire, postedAt: 'not a time' })).toThrow('no posting time');
    expect(() => readLine({ ...wire, direction: 'sideways' as never })).toThrow('no direction');
  });
});
