import { describe, expect, it } from 'vitest';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_EXPORT_INCOMPLETE } from './codes.js';
import type { HistoryRange, SubAccountActivityLine, TaxLedgerReads } from './ledger-reads.js';
import { TaxService } from './tax-service.js';

/**
 * TRD-0534. Worked figures are independent of the implementation:
 * second fill 50000 − 40000 = 10000; second convert 10 − 8 = 2; account 10002.
 * Fee and maker rebate stay in their own columns, so they are not in that subtraction.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const FIRST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const money = (value: string | null): Amount | null => (value === null ? null : parseAmount(value));

function line(partial: {
  id: string;
  kind: 'fill' | 'convert';
  at: string;
  assetId: string;
  qty: string;
  fee: string | null;
  makerRebate: string | null;
  costBasis: string | null;
  proceeds: string | null;
}): SubAccountActivityLine {
  return {
    id: partial.id,
    kind: partial.kind,
    postedAt: new Date(partial.at),
    assetId: partial.assetId,
    qty: parseAmount(partial.qty),
    fee: money(partial.fee),
    makerRebate: money(partial.makerRebate),
    costBasis: money(partial.costBasis),
    proceeds: money(partial.proceeds),
  };
}

function reads(activity: Record<string, readonly SubAccountActivityLine[]>, calls?: { activity: number }): TaxLedgerReads {
  return {
    async balances() {
      return [];
    },
    async history() {
      return [];
    },
    async subAccountIds() {
      return [FIRST, SECOND];
    },
    async subAccountActivity(subAccountId) {
      if (calls) calls.activity += 1;
      return activity[subAccountId] ?? [];
    },
  };
}

function service(ledger: TaxLedgerReads, historyYears = 10, now = '2026-06-15T12:00:00.000Z') {
  return new TaxService({
    mapRaw: '["DE"]',
    reads: ledger,
    lake: { status: 'absent', code: 'tax.data_lake_unavailable' },
    indexer: { status: 'absent', code: 'tax.indexer_unavailable' },
    historyYears,
    now: () => new Date(now),
  });
}

interface YearLine {
  kind: 'fill' | 'convert';
  postedAt: string;
  fee: string | null;
  makerRebate: string | null;
  costBasis: string | null;
  proceeds: string | null;
  realized: string | null;
}

interface YearAccount {
  subAccountId: string;
  lines: YearLine[];
  realized: string | null;
  residuals: string[];
}

interface YearBody {
  complete: boolean;
  realized: string | null;
  residuals: string[];
  subAccountBooks: 'unwired' | 'read';
  subAccounts: YearAccount[];
}

async function download(tax: TaxService): Promise<YearBody> {
  const pack = await tax.exportPack({ userId: USER, region: 'DE', lotMethod: 'FIFO' });
  return JSON.parse(Buffer.from(pack.bodyBase64, 'base64').toString('utf8')) as YearBody;
}

const TWO_BOOKS: Record<string, readonly SubAccountActivityLine[]> = {
  [FIRST]: [
    line({
      id: 'fill-a',
      kind: 'fill',
      at: '2025-03-01T00:00:00.000Z',
      assetId: 'BTC',
      qty: '1',
      fee: '0.1',
      makerRebate: null,
      costBasis: null,
      proceeds: '50000',
    }),
    line({
      id: 'convert-a',
      kind: 'convert',
      at: '2025-04-01T00:00:00.000Z',
      assetId: 'ETH',
      qty: '2',
      fee: null,
      makerRebate: null,
      costBasis: null,
      proceeds: '10',
    }),
  ],
  [SECOND]: [
    line({
      id: 'fill-b',
      kind: 'fill',
      at: '2025-03-02T00:00:00.000Z',
      assetId: 'BTC',
      qty: '1',
      fee: '1.5',
      makerRebate: '0.25',
      costBasis: '40000',
      proceeds: '50000',
    }),
    line({
      id: 'convert-b',
      kind: 'convert',
      at: '2025-04-02T00:00:00.000Z',
      assetId: 'ETH',
      qty: '3',
      fee: '0.01',
      makerRebate: null,
      costBasis: '8',
      proceeds: '10',
    }),
  ],
};

describe('TRD-0534 year pack', () => {
  it('leaves the first sub-account realised gain null and does not assign that missing basis to the second', async () => {
    const body = await download(service(reads(TWO_BOOKS)));
    const first = body.subAccounts[0];
    const second = body.subAccounts[1];
    expect(first?.subAccountId).toBe(FIRST);
    expect(second?.subAccountId).toBe(SECOND);
    expect(first?.realized).toBeNull();
    expect(first?.lines.map((row) => row.costBasis)).toEqual([null, null]);
    expect(first?.lines.map((row) => row.realized)).toEqual([null, null]);
    expect(second?.lines.map((row) => row.costBasis)).toEqual(['40000', '8']);
    expect(second?.lines.map((row) => row.realized)).toEqual(['10000', '2']);
    expect(second?.realized).toBe('10002');
    expect(body.realized).toBeNull();
    expect(first?.lines.map((row) => [row.kind, row.fee, row.makerRebate])).toEqual([
      ['fill', '0.1', null],
      ['convert', null, null],
    ]);
    expect(second?.lines.map((row) => [row.kind, row.fee, row.makerRebate])).toEqual([
      ['fill', '1.5', '0.25'],
      ['convert', '0.01', null],
    ]);
  });

  it('keeps a null basis as a residual and does not rewrite it as zero', async () => {
    const body = await download(service(reads(TWO_BOOKS)));
    const first = body.subAccounts[0];
    const second = body.subAccounts[1];
    expect(first?.residuals).toContain(TAX_COST_BASIS_UNAVAILABLE);
    expect(second?.residuals).not.toContain(TAX_COST_BASIS_UNAVAILABLE);
    expect(body.residuals).toContain(TAX_COST_BASIS_UNAVAILABLE);
    expect(JSON.stringify(first)).not.toMatch(/"costBasis": "0"/);
    expect(JSON.stringify(first)).not.toMatch(/"realized": "0"/);
    expect(JSON.stringify(first)).not.toMatch(/"makerRebate": "0"/);
  });

  it('refuses complete=true and does not read sub-account books', async () => {
    const calls = { activity: 0 };
    const tax = service(reads(TWO_BOOKS, calls));
    await expect(tax.exportPack({ userId: USER, region: 'DE', lotMethod: 'FIFO', complete: true })).rejects.toMatchObject({
      code: TAX_EXPORT_INCOMPLETE,
    });
    expect(calls.activity).toBe(0);
  });

  it('exports years inside the published window and leaves an earlier null basis out', async () => {
    let captured: HistoryRange | undefined;
    const ledger = reads({
      [FIRST]: [],
      [SECOND]: [
        line({
          id: 'before-window',
          kind: 'fill',
          at: '2023-12-31T23:59:59.999Z',
          assetId: 'BTC',
          qty: '1',
          fee: '1',
          makerRebate: null,
          costBasis: null,
          proceeds: '9',
        }),
        line({
          id: 'inside-window',
          kind: 'fill',
          at: '2024-01-01T00:00:00.000Z',
          assetId: 'BTC',
          qty: '1',
          fee: '1.5',
          makerRebate: '0.25',
          costBasis: '40000',
          proceeds: '50000',
        }),
        line({
          id: 'after-window',
          kind: 'convert',
          at: '2026-06-15T12:00:00.001Z',
          assetId: 'ETH',
          qty: '1',
          fee: null,
          makerRebate: null,
          costBasis: null,
          proceeds: '3',
        }),
      ],
    });
    const tax = new TaxService({
      mapRaw: '["DE"]',
      reads: {
        ...ledger,
        async subAccountActivity(subAccountId, range) {
          captured = range;
          return ledger.subAccountActivity!(subAccountId, range);
        },
      },
      lake: { status: 'absent', code: 'tax.data_lake_unavailable' },
      indexer: { status: 'absent', code: 'tax.indexer_unavailable' },
      historyYears: 2,
      now: () => new Date('2026-06-15T12:00:00.000Z'),
    });
    const body = await download(tax);
    expect(captured?.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(captured?.to.toISOString()).toBe('2026-06-15T12:00:00.000Z');
    expect(body.complete).toBe(false);
    expect(body.subAccountBooks).toBe('read');
    const second = body.subAccounts.find((account) => account.subAccountId === SECOND);
    expect(second?.lines.map((row) => row.postedAt)).toEqual(['2024-01-01T00:00:00.000Z']);
    expect(second?.realized).toBe('10000');
    expect(second?.residuals).not.toContain(TAX_COST_BASIS_UNAVAILABLE);
    expect(body.residuals).not.toContain(TAX_COST_BASIS_UNAVAILABLE);
  });
});
