import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAmount, type AccountRef } from '@intafaced/ledger-client';
import { TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNPROBED } from './codes.js';
import type { SubAccountActivityLine, TaxLedgerReads } from './ledger-reads.js';
import { TaxService } from './tax-service.js';

/**
 * The year export over a ledger that holds something, recorded for the Rust service (`crates/svc-tax/tests/export_parity.rs`).
 * The wire replay's ledger is empty, so it cannot tell an export of real lots apart; this can. The ledger is written into
 * the golden file as data, so both services read the same one, and each must produce the same pack, byte for byte.
 *
 * `EXPORT_PARITY_WRITE=1` rewrites the golden file: only for a change meant to change the export, named in its PR.
 */

const GOLDEN = new URL('./export-parity.golden.json', import.meta.url);
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-19T10:30:00.000Z';

/** The ledger: every amount a decimal string, every time an ISO string. */
const LEDGER = {
  balances: [
    { assetId: 'BTC', kind: 'available', amount: '1.25' },
    { assetId: 'BTC', kind: 'hold', amount: '0.5' },
    { assetId: 'ETH', kind: 'available', amount: '0' },
    { assetId: 'SOL', kind: 'available', amount: '-0.000000000000000001' },
  ],
  history: {
    BTC: [
      { txId: 'tx-b', direction: 'debit', amount: '1', postedAt: '2026-03-01T00:00:00.000Z', reason: 'trade.fill' },
      { txId: 'tx-A', direction: 'debit', amount: '0.5', postedAt: '2026-03-01T00:00:00.000Z', reason: 'trade.fill' },
      { txId: 'tx-a', direction: 'debit', amount: '0.25', postedAt: '2026-03-01T00:00:00.000Z', reason: 'deposit.crypto' },
      { txId: 'tx-0', direction: 'credit', amount: '0.1', postedAt: '2026-01-05T00:00:00.000Z', reason: 'trade.fill' },
      { txId: 'tx-z', direction: 'debit', amount: '0', postedAt: '2026-04-01T00:00:00.000Z', reason: 'trade.fill' },
      { txId: 'tx-s', direction: 'credit', amount: '0.5', postedAt: '2026-05-01T12:00:00.000Z', reason: 'trade.fill' },
    ],
    ETH: [{ txId: 'e1', direction: 'credit', amount: '2', postedAt: '2025-02-01T00:00:00.000Z', reason: 'withdraw.crypto' }],
    SOL: [],
  } as Record<string, Array<{ txId: string; direction: 'debit' | 'credit'; amount: string; postedAt: string; reason: string }>>,
  subAccounts: {
    'sub-2': [
      {
        id: 'l2',
        kind: 'fill',
        postedAt: '2026-06-01T00:00:00.000Z',
        assetId: 'BTC',
        qty: '1',
        fee: '0.01',
        makerRebate: null,
        costBasis: '100',
        proceeds: '150.5',
      },
      {
        id: 'l1',
        kind: 'convert',
        postedAt: '2026-06-01T00:00:00.000Z',
        assetId: 'ETH',
        qty: '2',
        fee: null,
        makerRebate: '0.002',
        costBasis: '10',
        proceeds: null,
      },
      {
        id: 'old',
        kind: 'fill',
        postedAt: '2010-01-01T00:00:00.000Z',
        assetId: 'BTC',
        qty: '1',
        fee: null,
        makerRebate: null,
        costBasis: null,
        proceeds: '1',
      },
    ],
    'sub-1': [
      {
        id: 'm1',
        kind: 'fill',
        postedAt: '2026-07-01T00:00:00.000Z',
        assetId: 'BTC',
        qty: '1',
        fee: null,
        makerRebate: null,
        costBasis: null,
        proceeds: '5',
      },
    ],
    'sub-3': [],
  } as Record<string, Array<Record<string, string | null>>>,
};

const money = (v: string | null) => (v === null ? null : parseAmount(v));

function reads(withSubAccounts: boolean): TaxLedgerReads {
  const base: TaxLedgerReads = {
    balances: async () =>
      LEDGER.balances.map((b) => ({
        account: { ownerType: 'user', ownerId: USER, assetId: b.assetId, kind: b.kind } as AccountRef,
        accountId: `${b.assetId}:${b.kind}`,
        amount: parseAmount(b.amount),
      })),
    history: async (account) =>
      (LEDGER.history[account.assetId] ?? []).map((e) => ({
        txId: e.txId,
        module: 'ledger',
        reason: e.reason,
        direction: e.direction,
        amount: parseAmount(e.amount),
        postedAt: new Date(e.postedAt),
      })),
  };
  if (!withSubAccounts) return base;
  return {
    ...base,
    subAccountIds: async () => Object.keys(LEDGER.subAccounts),
    subAccountActivity: async (id) =>
      (LEDGER.subAccounts[id] ?? []).map((l): SubAccountActivityLine => ({
        id: l.id!,
        kind: l.kind as 'fill' | 'convert',
        postedAt: new Date(l.postedAt!),
        assetId: l.assetId!,
        qty: parseAmount(l.qty!),
        fee: money(l.fee!),
        makerRebate: money(l.makerRebate!),
        costBasis: money(l.costBasis!),
        proceeds: money(l.proceeds!),
      })),
  };
}

const RUNS = [
  { name: 'ledger and sub-accounts, FIFO', subAccounts: true, lotMethod: 'FIFO', historyYears: 1 },
  { name: 'ledger only, HIFO, a longer window', subAccounts: false, lotMethod: 'HIFO', historyYears: 20 },
] as const;

async function packs() {
  const out: Array<{ name: string; subAccounts: boolean; lotMethod: string; historyYears: number; pack: string }> = [];
  for (const run of RUNS) {
    const tax = new TaxService({
      mapRaw: '{"DE":{}}',
      reads: reads(run.subAccounts),
      lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
      indexer: { status: 'configured', code: TAX_INDEXER_UNPROBED },
      historyYears: run.historyYears,
      now: () => new Date(NOW),
    });
    const pack = await tax.exportPack({ userId: USER, region: 'de', lotMethod: run.lotMethod });
    out.push({ ...run, pack: JSON.stringify(pack) });
  }
  return { user: USER, now: NOW, ledger: LEDGER, runs: out };
}

describe('export parity: the year export over a ledger that holds something, recorded for the Rust service', () => {
  it('each run gives the recorded pack', async () => {
    const now = await packs();
    if (process.env.EXPORT_PARITY_WRITE === '1') writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    expect(now).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
