import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ActivityService, type LedgerPageEntry, type LedgerPageRequest } from '../activity/activity-service.js';
import { StatementService } from './statement-service.js';
import { signStatement } from './statement-file.js';

const SECRET = 'a-bank-statement-test-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';

function activity(): ActivityService {
  const row: LedgerPageEntry & { seq: number } = {
    txId: 'tx-1',
    module: 'bank',
    reason: 'bank.transfer.manual',
    direction: 'credit',
    amount: '12.50',
    postedAt: new Date('2026-10-04T00:00:00.000Z'),
    assetId: 'USDT',
    entryId: '1',
    seq: 1,
  };
  return new ActivityService(
    { allNamedSpaces: async () => [] },
    {
      cursorSecret: SECRET,
      pages: {
        async page(req: LedgerPageRequest) {
          if (req.cursor !== undefined || req.ownerType !== 'user') return { entries: [], nextCursor: null };
          return {
            entries: [
              {
                txId: row.txId,
                module: row.module,
                reason: row.reason,
                direction: row.direction,
                amount: row.amount,
                postedAt: row.postedAt,
                assetId: row.assetId,
                entryId: row.entryId,
              },
            ],
            nextCursor: null,
          };
        },
      },
    },
  );
}

describe('bank.statements.export', () => {
  it('signs a CSV of the exact decimal and does not state a balance', async () => {
    const file = await new StatementService(activity(), SECRET).export(ALICE, {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-31T23:59:59.000Z',
      format: 'csv',
      now: new Date('2026-10-17T00:00:00.000Z'),
    });
    const bytes = Buffer.from(file.bodyBase64, 'base64');
    const text = bytes.toString('utf8');
    expect(text).toContain('12.50');
    expect(text).toContain('-12.50');
    expect(text).not.toContain('Balance');
    expect(file.rowCount).toBe(1);
    expect(file.proof).toMatchObject({ holderUserId: ALICE, rowCount: 1, sha256: file.sha256 });
    expect(signStatement(SECRET, bytes)).toEqual({ sha256: file.sha256, signature: file.signature });
    const key = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), 'bank.statement.file.v1', 32));
    expect(file.signature).toBe(createHmac('sha256', key).update(bytes).digest('hex'));
  });

  it('builds a one-month PDF and refuses a range that crosses months', async () => {
    const statements = new StatementService(activity(), SECRET);
    const pdf = await statements.export(ALICE, {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z',
      format: 'pdf',
    });
    expect(Buffer.from(pdf.bodyBase64, 'base64').subarray(0, 8).toString('utf8')).toBe('%PDF-1.4');
    expect(pdf.contentType).toBe('application/pdf');
    await expect(
      statements.export(ALICE, { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', format: 'pdf' }),
    ).rejects.toMatchObject({ code: 'bank.statement_pdf_one_month' });
  });

  it('draws every row of a 120-line month on more than one page', async () => {
    const rows: LedgerPageEntry[] = Array.from({ length: 120 }, (_, index) => ({
      txId: `T${String(index + 1).padStart(3, '0')}Z`,
      module: 'bank',
      reason: 'bank.transfer.manual',
      direction: 'credit' as const,
      amount: '1.00',
      postedAt: new Date('2026-10-04T00:00:00.000Z'),
      assetId: 'USDT',
      entryId: String(index + 1),
    }));
    const service = new ActivityService(
      { allNamedSpaces: async () => [] },
      {
        cursorSecret: SECRET,
        pages: {
          async page(req: LedgerPageRequest) {
            if (req.ownerType !== 'user') return { entries: [], nextCursor: null };
            let start = 0;
            if (req.cursor !== undefined) {
              const raw = Buffer.from(req.cursor, 'base64url').toString('utf8');
              const match = /^bankstmt\.(\d+)$/.exec(raw);
              start = match ? Number(match[1]) : rows.length;
            }
            const entries = rows.slice(start, start + req.limit);
            const next = start + entries.length;
            const nextCursor = next < rows.length ? Buffer.from(`bankstmt.${next}`, 'utf8').toString('base64url') : null;
            return { entries, nextCursor };
          },
        },
      },
    );
    const file = await new StatementService(service, SECRET).export(ALICE, {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-31T23:59:59.000Z',
      format: 'pdf',
      now: new Date('2026-10-17T00:00:00.000Z'),
    });
    const bytes = Buffer.from(file.bodyBase64, 'base64');
    const text = bytes.toString('utf8');
    for (const row of rows) expect(text).toContain(row.txId);
    expect(text).toMatch(/\/Count [2-9]/);
    expect(file.rowCount).toBe(120);
    expect(file.proof.rowCount).toBe(120);
    expect(signStatement(SECRET, bytes)).toEqual({ sha256: file.sha256, signature: file.signature });
  });

  it('refuses when the signing secret is unset', async () => {
    await expect(
      new StatementService(activity(), undefined).export(ALICE, {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        format: 'csv',
      }),
    ).rejects.toMatchObject({ code: 'bank.statement_unavailable' });
  });

  it('a trades file holds only trade lines and order fees, names its report in its proof, and says it is not a tax form', async () => {
    const at = new Date('2026-10-04T00:00:00.000Z');
    const rows: LedgerPageEntry[] = [
      {
        txId: 'tx-fill',
        module: 'trade',
        reason: 'trade.fill',
        direction: 'debit',
        amount: '0.003',
        postedAt: at,
        assetId: 'BTC',
        entryId: '3',
      },
      {
        txId: 'tx-fee',
        module: 'ledger',
        reason: 'fee.charged',
        direction: 'credit',
        amount: '0.10',
        postedAt: at,
        assetId: 'USDT',
        entryId: '2',
        orderId: 'order-1',
      },
      {
        txId: 'tx-withdraw-fee',
        module: 'ledger',
        reason: 'fee.charged',
        direction: 'credit',
        amount: '1.00',
        postedAt: at,
        assetId: 'USDT',
        entryId: '4',
      },
      {
        txId: 'tx-send',
        module: 'bank',
        reason: 'bank.transfer.manual',
        direction: 'credit',
        amount: '12.50',
        postedAt: at,
        assetId: 'USDT',
        entryId: '1',
      },
    ];
    const service = new ActivityService(
      { allNamedSpaces: async () => [] },
      {
        cursorSecret: SECRET,
        pages: {
          async page(req: LedgerPageRequest) {
            if (req.cursor !== undefined || req.ownerType !== 'user') return { entries: [], nextCursor: null };
            return { entries: rows, nextCursor: null };
          },
        },
      },
    );
    const statements = new StatementService(service, SECRET);
    const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z', now: new Date('2026-11-02T00:00:00.000Z') };
    const trades = await statements.export(ALICE, { ...range, format: 'csv', report: 'trades' });
    const csv = Buffer.from(trades.bodyBase64, 'base64').toString('utf8');
    expect(trades.rowCount).toBe(2);
    expect(csv).toContain('tx-fill');
    expect(csv).toContain('tx-fee');
    expect(csv).not.toContain('tx-send');
    expect(csv).not.toContain('tx-withdraw-fee');
    expect(trades.proof.report).toBe('trades');
    expect(trades.filename).toBe('intafaced-trades-2026-11-02.csv');
    const pdf = await statements.export(ALICE, { ...range, format: 'pdf', report: 'trades' });
    const drawn = Buffer.from(pdf.bodyBase64, 'base64').toString('utf8');
    expect(drawn).toContain('INTAFACED account trade history');
    expect(drawn).toContain('Trade lines and their order fees only');
    expect(pdf.filename).toBe('intafaced-trades-history-2026-10.pdf');
    expect(drawn).toContain('This is not a tax form.');
    // The ledger and the account statement hold every line.
    for (const report of ['ledger', 'statement'] as const) {
      const file = await statements.export(ALICE, { ...range, format: 'csv', report });
      expect(file.rowCount).toBe(4);
      expect(file.proof.report).toBe(report);
    }
    // The same request signs the same file.
    expect((await statements.export(ALICE, { ...range, format: 'csv', report: 'trades' })).sha256).toBe(trades.sha256);
  });

  it('refuses a balance snapshot, which needs a past-balance read the ledger does not offer', async () => {
    await expect(
      new StatementService(activity(), SECRET).export(ALICE, {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-01T23:59:59.999Z',
        format: 'csv',
        report: 'balances',
      }),
    ).rejects.toMatchObject({ code: 'bank.statement_balances_unavailable' });
  });
});
