import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import {
  PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED,
  TAX_BASIS_OVERRIDE_ABSENT,
  TAX_BASIS_PRICE_UNSET,
  TAX_BASIS_STORE_UNWIRED,
  TAX_COST_BASIS_UNAVAILABLE,
  TAX_CUSTOMER_BASIS_EXPORT_UNSET,
  TAX_DATA_LAKE_UNAVAILABLE,
  TAX_INDEXER_UNAVAILABLE,
  UNKNOWN_SHARE,
} from './codes.js';
import { createMemoryBasisStore } from './basis-store.js';
import type { Fill } from './lot-book.js';
import type { InflowLine, TaxLedgerReads } from './ledger-reads.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const at = (day: number) => new Date(Date.UTC(2026, 0, day, 12));
const SECRET = 'a-tax-basis-edge-secret-value-long-enough';

const sell: Fill = {
  txId: 's1',
  postedAt: at(10),
  received: { assetId: 'USDT', amount: amt('150') },
  paid: { assetId: 'BTC', amount: amt('1') },
};
const buy: Fill = {
  txId: 'b1',
  postedAt: at(1),
  received: { assetId: 'BTC', amount: amt('1') },
  paid: { assetId: 'USDT', amount: amt('100') },
};
const deposit: InflowLine = { txId: 'd1', postedAt: at(2), assetId: 'BTC', amount: amt('1'), reason: 'deposit.credited' };

function reads(fills: Fill[], inflows: InflowLine[], held: Record<string, string>): TaxLedgerReads {
  return {
    balances: async () =>
      Object.entries(held).map(([assetId, amount]) => ({
        account: { ownerType: 'user', ownerId: USER, assetId, kind: 'available' },
        accountId: `a-${assetId}`,
        amount: amt(amount),
      })),
    history: async () => [],
    tradeFills: async () => ({ fills, truncated: false, outsideInflows: new Set(inflows.map((line) => line.assetId)), inflows }),
  };
}

function service(store = createMemoryBasisStore(), book = reads([sell], [deposit], {})) {
  return new TaxService({
    mapRaw: '["DE"]',
    reads: book,
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    historyYears: 10,
    depositBasis: 'customer',
    now: () => at(20),
    basis: store,
  });
}

const write = {
  lotId: 'lot:d1:BTC',
  pricePerUnit: '100',
  date: '2026-01-02T00:00:00.000Z',
  sourceNote: 'TEST receipt',
};

describe('customer-entered basis (PF-cost-basis-04)', () => {
  it('names the lot and unknown share, then recomputes from the entered price and keeps the unknown on record', async () => {
    const store = createMemoryBasisStore();
    const tax = service(store);
    const before = await tax.missingBasis({ userId: USER });
    expect(before.items).toEqual([
      {
        lotId: 'lot:d1:BTC',
        assetId: 'BTC',
        kind: 'disposal',
        qty: '1',
        code: TAX_COST_BASIS_UNAVAILABLE,
        effect: UNKNOWN_SHARE,
        saleTxId: 's1',
      },
    ]);
    expect((await tax.lotBook({ userId: USER })).sales[0]?.realizedUsd).toBeNull();

    const saved = await tax.basisOverrideSet({ userId: USER, ...write });
    expect(saved).toMatchObject({ version: 1, kind: 'override', basisSource: 'customer-entered' });
    expect(saved.businessKey).toBe(`basisoverride:${USER}:lot:d1:BTC:1`);
    const again = await tax.basisOverrideSet({ userId: USER, ...write, pricePerUnit: '100.0' });
    expect(again.version).toBe(1);
    expect(again.businessKey).toBe(saved.businessKey);

    const after = await tax.lotBook({ userId: USER });
    expect(after.sales[0]).toMatchObject({ realizedUsd: '50', costUsd: '100', basisSource: 'customer-entered' });
    expect(after.sales[0]?.matches[0]).toMatchObject({ lotId: 'lot:d1:BTC', costUsd: '100', basisSource: 'customer-entered' });
    expect(after.lots.find((lot) => lot.id === 'lot:d1:BTC')).toMatchObject({ costUsd: '100', basisSource: 'customer-entered' });
    expect(await tax.missingBasis({ userId: USER })).toEqual({ items: [] });

    const removed = await tax.basisOverrideRemove({ userId: USER, lotId: 'lot:d1:BTC' });
    expect(removed.kind).toBe('tombstone');
    expect(removed.basisSource).toBeNull();
    const removedAgain = await tax.basisOverrideRemove({ userId: USER, lotId: 'lot:d1:BTC' });
    expect(removedAgain.version).toBe(removed.version);
    expect((await tax.lotBook({ userId: USER })).sales[0]?.realizedUsd).toBeNull();
    expect((await store.listActive(USER)).length).toBe(0);
  });

  it('refuses a lot that already has a cost from a fill, a blank price, and a missing store', async () => {
    const tax = service(createMemoryBasisStore(), reads([buy], [], { BTC: '1' }));
    await expect(tax.basisOverrideSet({ userId: USER, ...write, lotId: 'lot:b1:BTC' })).rejects.toMatchObject({
      code: PORTFOLIO_BASIS_OVERRIDE_NOT_ALLOWED,
    });
    await expect(tax.basisOverrideSet({ userId: USER, ...write, pricePerUnit: '  ' })).rejects.toMatchObject({
      code: TAX_BASIS_PRICE_UNSET,
    });
    await expect(tax.basisOverrideRemove({ userId: USER, lotId: 'lot:missing' })).rejects.toMatchObject({
      code: TAX_BASIS_OVERRIDE_ABSENT,
    });
    const bare = new TaxService({
      mapRaw: '',
      reads: reads([], [], {}),
      lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
      indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    });
    await expect(bare.basisOverrideSet({ userId: USER, ...write })).rejects.toMatchObject({ code: TAX_BASIS_STORE_UNWIRED });
  });

  it('keeps a manual position out of the holding totals', async () => {
    const tax = service(createMemoryBasisStore(), reads([buy], [], { BTC: '1' }));
    await tax.basisOverrideSet({
      userId: USER,
      lotId: `manual:${USER}:desk`,
      pricePerUnit: '10',
      date: '2026-01-01T00:00:00.000Z',
      sourceNote: 'TEST desk',
      assetId: 'ETH',
      qty: '2',
    });
    const book = await tax.lotBook({ userId: USER });
    expect(book.manualPositions).toEqual([
      {
        id: `manual:${USER}:desk`,
        assetId: 'ETH',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        qty: '2',
        costUsd: '20',
        pricePerUnit: '10',
        sourceNote: 'TEST desk',
        basisSource: 'customer-entered',
        heldApart: true,
      },
    ]);
    expect(book.assets.find((row) => row.assetId === 'ETH')).toBeUndefined();
    expect(book.assets.find((row) => row.assetId === 'BTC')).toMatchObject({ openQty: '1', held: '1', openCostUsd: '100' });
    expect(book.lots.find((lot) => lot.assetId === 'ETH')).toBeUndefined();
  });

  it("does not show one customer's price on another customer's book, and marks the pack", async () => {
    const tax = service();
    await tax.basisOverrideSet({ userId: USER, ...write });
    const theirs = await tax.lotBook({ userId: OTHER });
    expect(theirs.lots.find((lot) => lot.id === 'lot:d1:BTC')?.basisSource).toBeUndefined();
    expect(theirs.sales[0]?.realizedUsd).toBeNull();
    const pack = await tax.exportPreview({ userId: USER, region: 'DE', lotMethod: 'FIFO' });
    expect(pack.residuals).toContain(TAX_CUSTOMER_BASIS_EXPORT_UNSET);
    const clean = await service().exportPreview({ userId: USER, region: 'DE', lotMethod: 'FIFO' });
    expect(clean.residuals).not.toContain(TAX_CUSTOMER_BASIS_EXPORT_UNSET);
  });

  it('refuses a read scope on the write, and accepts tax:write for the caller only', async () => {
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-tax' });
    const caller = async (scopes: string[]) => {
      const principal = {
        sub: USER,
        userId: USER,
        sid: OTHER,
        scopes,
        tier: 'none',
        mfa: false,
        expiresAt: new Date(Date.now() + 60_000),
      } as Principal;
      const raw = encodePrincipal(principal);
      return createTaxRouter(service()).createCaller(
        await edge({
          headers: {
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
            'x-intafaced-region': 'DE',
          },
          id: 'req-basis',
        }),
      );
    };
    const reader = await caller(['tax:read']);
    await expect(reader.basisOverride.set(write)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const writer = await caller(['tax:read', 'tax:write']);
    const saved = await writer.basisOverride.set(write);
    expect(saved.version).toBe(1);
    expect(saved.lotId).toBe('lot:d1:BTC');
  });
});
