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

  it('refuses when the signing secret is unset', async () => {
    await expect(
      new StatementService(activity(), undefined).export(ALICE, {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        format: 'csv',
      }),
    ).rejects.toMatchObject({ code: 'bank.statement_unavailable' });
  });
});
