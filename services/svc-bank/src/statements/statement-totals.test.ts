import { describe, expect, it } from 'vitest';
import { ActivityService, type LedgerPageEntry, type LedgerPageRequest } from '../activity/activity-service.js';
import { BankError } from '../errors.js';
import { StatementService } from './statement-service.js';
import { lineTotals } from './statement-file.js';

// J-bank-16 #1: a statement carries the net of its lines per asset, and `statements.totals` folds the same lines the
// same way, so the file and the activity list show the same total. Neither states a balance.

const SECRET = 'a-bank-statement-test-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const MONTH = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

function entry(n: number, direction: 'debit' | 'credit', amount: string, assetId = 'USDT', reason = 'bank.transfer.manual') {
  return {
    txId: `tx-${n}`,
    module: 'bank',
    reason,
    direction,
    amount,
    postedAt: new Date(Date.UTC(2026, 9, 2 + n)),
    assetId,
    entryId: String(n),
  } satisfies LedgerPageEntry;
}

function activity(entries: LedgerPageEntry[]): ActivityService {
  return new ActivityService(
    { allNamedSpaces: async () => [] },
    {
      cursorSecret: SECRET,
      pages: {
        async page(req: LedgerPageRequest) {
          if (req.ownerType !== 'user') return { entries: [], nextCursor: null };
          // Paged the way svc-ledger pages: up to the limit asked for, with an offset cursor while rows remain.
          const from = req.cursor === undefined ? 0 : Number(req.cursor);
          const to = from + req.limit;
          return { entries: entries.slice(from, to), nextCursor: to < entries.length ? String(to) : null };
        },
      },
    },
  );
}

// Debit raises the user's available account (money in); credit lowers it (money out).
const LINES = [
  entry(1, 'debit', '100', 'USDT', 'deposit.crypto'),
  entry(2, 'debit', '50.25', 'USDT', 'deposit.crypto'),
  entry(3, 'credit', '80.000000000000000001'),
  entry(4, 'debit', '0.5', 'BTC', 'deposit.crypto'),
];

describe('lineTotals', () => {
  it('nets money in minus money out per asset, exactly, sorted by asset', () => {
    expect(
      lineTotals([
        { asset: 'USDT', direction: 'in', amount: '100' },
        { asset: 'USDT', direction: 'out', amount: '100.000000000000000001' },
        { asset: 'BTC', direction: 'in', amount: '0.1' },
      ]),
    ).toEqual([
      { asset: 'BTC', net: '0.1', lines: 1 },
      { asset: 'USDT', net: '-0.000000000000000001', lines: 2 },
    ]);
    expect(lineTotals([])).toEqual([]);
  });
});

describe('statement totals (J-bank-16 #1)', () => {
  it('prints the same per-asset total in the PDF and in `totals` as the activity total over the same month', async () => {
    const service = new StatementService(activity(LINES), SECRET);
    const file = await service.export(ALICE, { ...MONTH, format: 'pdf', now: new Date('2026-11-02T00:00:00.000Z') });
    const expected = [
      { asset: 'BTC', net: '0.5', lines: 1 },
      { asset: 'USDT', net: '70.249999999999999999', lines: 3 },
    ];
    expect(file.rowCount).toBe(4);
    expect(file.totals).toEqual(expected);
    const pdf = Buffer.from(file.bodyBase64, 'base64').toString('utf8');
    expect(pdf).toContain('Total USDT: 70.249999999999999999 \\(3 lines\\)');
    expect(pdf).toContain('Total BTC: 0.5 \\(1 lines\\)');
    expect(pdf).toContain('not a balance');

    const listed = await service.totals(ALICE, MONTH);
    expect(listed).toEqual({ totals: expected, lines: 4 });
  });

  it('says a month with no lines has none, and totals it as an empty list', async () => {
    const service = new StatementService(activity([]), SECRET);
    const file = await service.export(ALICE, { ...MONTH, format: 'pdf', now: new Date('2026-11-02T00:00:00.000Z') });
    expect(file.totals).toEqual([]);
    expect(Buffer.from(file.bodyBase64, 'base64').toString('utf8')).toContain('No lines in this period.');
    expect(await service.totals(ALICE, MONTH)).toEqual({ totals: [], lines: 0 });
  });

  it('refuses a backwards or over-long range, and a range past the line cap, never totalling part of it', async () => {
    const service = new StatementService(activity(LINES), SECRET);
    await expect(service.totals(ALICE, { from: MONTH.to, to: MONTH.from })).rejects.toMatchObject({ code: 'bank.statement_range' });
    await expect(service.totals(ALICE, { from: '2025-01-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'bank.statement_range',
    });
    const many = Array.from({ length: 5_001 }, (_, i) => ({ ...entry(1, 'debit', '1'), txId: `tx-${i}`, entryId: String(i) }));
    const big = new StatementService(activity(many), SECRET);
    const refused = await big.totals(ALICE, MONTH).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(BankError);
    expect(refused).toMatchObject({ code: 'bank.statement_too_large' });
  });
});
