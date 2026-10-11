/**
 * Public export doors. A blank tax map is not an export.
 * Slot stays empty. No figure. No balance on this service.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { formatAmount, MemoryLedger, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNAVAILABLE, TAX_JURISDICTION_UNMAPPED } from './codes.js';
import type { TaxLedgerReads } from './ledger-reads.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

const SECRET = 'a-tax-map-refusal-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-tax' });

function principal(): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['tax:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

async function signed() {
  const raw = encodePrincipal(principal());
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-tax-map',
  });
}

/**
 * A ledger quantity the export must not reprint as a tax figure.
 * Not an owner-published rate. History years stay unset on the service.
 */
const LEDGER_QTY = '4.25';

const BLANK_MAPS = ['', '   ', '{}', '[]'] as const;

function readsFrom(ledger: LedgerClient): TaxLedgerReads {
  return {
    async balances(ownerType, ownerId) {
      const rows = await ledger.balances(ownerType, ownerId);
      return rows.map((row) => ({
        account: row.account,
        accountId: row.accountId,
        amount: row.amount,
      }));
    },
    async history() {
      // Trap quantity. A blank map must not turn this row into a tax figure.
      return [
        {
          txId: 'tx-ledger-only',
          module: 'ledger',
          reason: 'deposit.credited',
          direction: 'debit',
          amount: parseAmount(LEDGER_QTY),
          postedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      ];
    },
  };
}

function taxOn(ledger: LedgerClient, mapRaw = '') {
  return new TaxService({
    mapRaw,
    reads: readsFrom(ledger),
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
  });
}

function refusalText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : '';
  return `${err.message}\n${cause}`;
}

describe('public tax export while the tax map is blank', () => {
  it('returns tax.jurisdiction_unmapped and an empty slot', async () => {
    const api = createTaxRouter(taxOn(new MemoryLedger())).createCaller(await signed());

    for (const door of ['exportPack', 'exportPreview'] as const) {
      let slot: unknown = { present: true };
      try {
        slot = await api[door]({ lotMethod: 'FIFO' });
      } catch (err) {
        expect(err).toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringContaining(TAX_JURISDICTION_UNMAPPED),
        });
        slot = null;
      }
      expect(slot).toBeNull();
    }
  });

  it('does not invent a tax figure', async () => {
    for (const mapRaw of BLANK_MAPS) {
      const api = createTaxRouter(taxOn(new MemoryLedger(), mapRaw)).createCaller(await signed());
      for (const door of ['exportPack', 'exportPreview'] as const) {
        let slot: unknown = { realized: LEDGER_QTY };
        try {
          slot = await api[door]({ lotMethod: 'FIFO' });
        } catch (err) {
          const text = refusalText(err);
          expect(text).toContain(TAX_JURISDICTION_UNMAPPED);
          expect(text).not.toContain(LEDGER_QTY);
          expect(text).not.toMatch(/\d/);
          slot = null;
        }
        expect(slot).toBeNull();
      }
    }
  });

  it('keeps no balance of its own', async () => {
    const ledger = new MemoryLedger();
    let posts = 0;
    const post = ledger.post.bind(ledger);
    ledger.post = async (request) => {
      posts += 1;
      return post(request);
    };
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: 'BTC',
        amount: parseAmount(LEDGER_QTY),
        rail: 'test',
        railRef: 'tax-map-refusal-fixture',
      }),
    );
    expect(posts).toBe(1);

    const api = createTaxRouter(taxOn(ledger)).createCaller(await signed());
    await expect(api.exportPack({ lotMethod: 'FIFO' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(TAX_JURISDICTION_UNMAPPED),
    });
    await expect(api.exportPreview({ lotMethod: 'FIFO' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(TAX_JURISDICTION_UNMAPPED),
    });

    expect(posts).toBe(1);
    const held = await ledger.balances('user', USER);
    expect(held.map((row) => formatAmount(row.amount))).toEqual([LEDGER_QTY]);
    expect(await ledger.balances('module', 'svc-tax')).toEqual([]);
    expect(await ledger.balances('house', 'tax')).toEqual([]);
  });
});
