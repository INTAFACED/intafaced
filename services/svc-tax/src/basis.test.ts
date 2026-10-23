import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { memoryChoices } from './choices.js';
import { TAX_BASIS_LOT_UNKNOWN, TAX_BASIS_OVERRIDE_NOT_ALLOWED, TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNAVAILABLE } from './codes.js';
import type { InflowLine, TaxLedgerReads } from './ledger-reads.js';
import { buildLotBook, type Fill } from './lot-book.js';
import { runLotEngine, type EngineMovement } from './lot-engine.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

// Every figure here is hand-computed TEST data, not a real balance or a real price.
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
const s = (v: bigint | null) => (v === null ? null : (Number(v) / 1e18).toString());

const arrive = (txId: string, day: number, cost: string | null, source: 'trade' | 'deposit' = 'deposit'): EngineMovement => ({
  side: 'acquire',
  txId,
  postedAt: at(day),
  assetId: 'BTC',
  qty: amt('2'),
  costUsd: cost === null ? null : amt(cost),
  source,
  reason: source === 'trade' ? 'trade.fill' : 'deposit.credited',
  valuedAt: null,
});
const sell = (txId: string, day: number, qty: string, proceeds: string): EngineMovement => ({
  side: 'dispose',
  txId,
  postedAt: at(day),
  assetId: 'BTC',
  qty: amt(qty),
  proceedsUsd: amt(proceeds),
});

describe('a price the customer entered, in the engine', () => {
  it('gives a lot with no basis a cost of quantity times that price, and flags every figure that uses it', () => {
    // 2 deposited (no basis), entered at 100 a coin: cost 200. Sell 1 for 300: cost 100, result 200, customer-entered.
    const run = runLotEngine([arrive('d1', 1, null), sell('s1', 2, '1', '300')], 'FIFO', new Map([['lot:d1:BTC', amt('100')]]));
    expect(run.lots[0]).toMatchObject({
      costUsd: amt('200'),
      enteredPrice: amt('100'),
      remainingCostUsd: amt('100'),
      remainingCustomerEntered: true,
    });
    expect(run.sales[0]).toMatchObject({ costUsd: amt('100'), realizedUsd: amt('200'), customerEntered: true });
    expect(run.sales[0]!.matches[0]!.customerEntered).toBe(true);
  });

  it('is ignored for a lot whose basis is ours', () => {
    const run = runLotEngine([arrive('b1', 1, '500', 'trade'), sell('s1', 2, '1', '300')], 'FIFO', new Map([['lot:b1:BTC', amt('1')]]));
    expect(run.lots[0]).toMatchObject({ costUsd: amt('500'), enteredPrice: null, remainingCustomerEntered: false });
    expect(run.sales[0]).toMatchObject({ realizedUsd: amt('50'), customerEntered: false });
  });

  it('under AVERAGE, one entered lot in the pool flags the sale and what is left', () => {
    // Bought 2 for 400, deposited 2 entered at 100 a coin (200): average 150. Sell 1 for 300: cost 150, result 150.
    const run = runLotEngine(
      [arrive('b1', 1, '400', 'trade'), arrive('d1', 2, null), sell('s1', 3, '1', '300')],
      'AVERAGE',
      new Map([['lot:d1:BTC', amt('100')]]),
    );
    expect(s(run.sales[0]!.realizedUsd)).toBe('150');
    expect(run.sales[0]!.customerEntered).toBe(true);
    expect(run.lots.every((l) => l.remainingCustomerEntered)).toBe(true);
  });
});

describe('what a missing cost touches', () => {
  // Bought 1 BTC for 100 (day 1); 1 BTC deposited with no cost (day 2); sold 2 for 600 (day 3), FIFO.
  const fills: Fill[] = [
    { txId: 'b1', postedAt: at(1), received: { assetId: 'BTC', amount: amt('1') }, paid: { assetId: 'USDT', amount: amt('100') } },
    { txId: 's1', postedAt: at(3), received: { assetId: 'USDT', amount: amt('600') }, paid: { assetId: 'BTC', amount: amt('2') } },
  ];
  const inflows = [
    {
      txId: 'd1',
      postedAt: at(2),
      assetId: 'BTC',
      amount: amt('1'),
      reason: 'deposit.credited',
      source: 'deposit' as const,
      costUsd: null,
      valuedAt: null,
    },
  ];
  const book = (entered = new Map()) => buildLotBook({ fills, held: new Map(), method: 'FIFO', truncated: false, inflows, entered });

  it('names the lot, the sale that drew on it, and the unknown share: its quantity and proceeds, its result unknown', () => {
    const b = book();
    expect(b.missingBasis).toEqual({
      lots: [
        {
          lotId: 'lot:d1:BTC',
          assetId: 'BTC',
          source: 'deposit',
          qty: '1',
          remaining: '0',
          sales: [{ txId: 's1', qty: '1', proceedsUsd: '300' }],
        },
      ],
      sales: [{ txId: 's1', assetId: 'BTC', unknownQty: '1', unknownProceedsUsd: '300' }],
    });
    expect(b.sales[0]).toMatchObject({ realizedUsd: null, customerEntered: false });
    expect(b.realizedUsd).toBeNull();
    expect(b.lots.find((l) => l.id === 'lot:d1:BTC')).toMatchObject({ basis: 'unknown', entered: null, costUsd: null });
  });

  it('with an entered price of 100 a coin: the result is 400, labelled customer-entered, and nothing is missing', () => {
    const b = book(new Map([['lot:d1:BTC', { pricePerUnit: amt('100'), note: 'my old exchange', version: 1 }]]));
    expect(b).toMatchObject({ realizedUsd: '400', realizedCustomerEntered: true, missingBasis: { lots: [], sales: [] } });
    expect(b.sales[0]).toMatchObject({ costUsd: '200', customerEntered: true });
    expect(b.lots.find((l) => l.id === 'lot:d1:BTC')).toMatchObject({
      basis: 'customer',
      costUsd: '100',
      entered: { pricePerUnitUsd: '100', note: 'my old exchange', version: 1 },
    });
    expect(b.lots.find((l) => l.id === 'lot:b1:BTC')).toMatchObject({ basis: 'ours', entered: null });
  });

  it('a sale that reached no lot is an unknown share too, with the proceeds left after the lots it did reach', () => {
    const b = buildLotBook({ fills, held: new Map(), method: 'FIFO', truncated: false });
    expect(b.missingBasis.sales).toEqual([{ txId: 's1', assetId: 'BTC', unknownQty: '1', unknownProceedsUsd: '300' }]);
  });
});

/** The ledger as svc-tax reads it: 1 BTC bought for 100, 1 BTC deposited, 2 sold for 600. Deposits have no cost of ours. */
function reads(users: string[] = [USER]): TaxLedgerReads {
  const fills: Fill[] = [
    { txId: 'b1', postedAt: at(1), received: { assetId: 'BTC', amount: amt('1') }, paid: { assetId: 'USDT', amount: amt('100') } },
    { txId: 's1', postedAt: at(3), received: { assetId: 'USDT', amount: amt('600') }, paid: { assetId: 'BTC', amount: amt('2') } },
  ];
  const inflows: InflowLine[] = [{ txId: 'd1', postedAt: at(2), assetId: 'BTC', amount: amt('1'), reason: 'deposit.credited' }];
  return {
    balances: async () => [],
    history: async () => [],
    tradeFills: async (userId) =>
      users.includes(userId)
        ? { fills, truncated: false, outsideInflows: new Set(), inflows }
        : { fills: [], truncated: false, outsideInflows: new Set(), inflows: [] },
  };
}
const service = (choices = memoryChoices(), r = reads()) =>
  new TaxService({
    mapRaw: '',
    reads: r,
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    depositBasis: 'customer',
    choices,
  });

describe('entering a price for a lot', () => {
  it('keeps versions: the same entry twice is one version, a change is the next, a removal returns the cost to unknown', async () => {
    const tax = service();
    expect(await tax.setLotBasis({ userId: USER, lotId: 'lot:d1:BTC', pricePerUnitUsd: '100', note: 'receipt' })).toBe(1);
    expect(await tax.setLotBasis({ userId: USER, lotId: 'lot:d1:BTC', pricePerUnitUsd: '100', note: 'receipt' })).toBe(1);
    expect((await tax.lotBook({ userId: USER })).realizedUsd).toBe('400');
    expect(await tax.setLotBasis({ userId: USER, lotId: 'lot:d1:BTC', pricePerUnitUsd: '250', note: 'receipt' })).toBe(2);
    const changed = await tax.lotBook({ userId: USER });
    expect(changed).toMatchObject({ realizedUsd: '250', realizedCustomerEntered: true });
    expect(changed.lots.find((l) => l.id === 'lot:d1:BTC')?.entered).toEqual({ pricePerUnitUsd: '250', note: 'receipt', version: 2 });
    expect(await tax.setLotBasis({ userId: USER, lotId: 'lot:d1:BTC', pricePerUnitUsd: null, note: '' })).toBe(3);
    const removed = await tax.lotBook({ userId: USER });
    expect(removed).toMatchObject({ realizedUsd: null, realizedCustomerEntered: false });
    expect(removed.lots.find((l) => l.id === 'lot:d1:BTC')).toMatchObject({ basis: 'unknown', entered: null });
    // Removing again adds nothing.
    expect(await tax.setLotBasis({ userId: USER, lotId: 'lot:d1:BTC', pricePerUnitUsd: null, note: '' })).toBe(3);
  });

  it('is refused for a lot whose cost is ours, and for a lot that is not in the caller’s book', async () => {
    const tax = service(memoryChoices(), reads([USER]));
    await expect(tax.setLotBasis({ userId: USER, lotId: 'lot:b1:BTC', pricePerUnitUsd: '1', note: '' })).rejects.toMatchObject({
      code: TAX_BASIS_OVERRIDE_NOT_ALLOWED,
    });
    await expect(tax.setLotBasis({ userId: USER, lotId: 'lot:nope:BTC', pricePerUnitUsd: '1', note: '' })).rejects.toMatchObject({
      code: TAX_BASIS_LOT_UNKNOWN,
    });
    // Another customer has no such lot, so they cannot set one on this customer's deposit.
    await expect(tax.setLotBasis({ userId: OTHER, lotId: 'lot:d1:BTC', pricePerUnitUsd: '1', note: '' })).rejects.toMatchObject({
      code: TAX_BASIS_LOT_UNKNOWN,
    });
  });

  it('one customer’s entry never reaches another customer’s book', async () => {
    const tax = service(memoryChoices(), reads([USER, OTHER]));
    await tax.setLotBasis({ userId: USER, lotId: 'lot:d1:BTC', pricePerUnitUsd: '100', note: '' });
    expect((await tax.lotBook({ userId: OTHER })).realizedUsd).toBeNull();
  });

  it('a trial shows the effect without saving anything', async () => {
    const tax = service();
    const trial = await tax.lotBook({ userId: USER, trial: { lotId: 'lot:d1:BTC', pricePerUnitUsd: '150' } });
    expect(trial).toMatchObject({
      realizedUsd: '350',
      realizedCustomerEntered: true,
      trial: { lotId: 'lot:d1:BTC', pricePerUnitUsd: '150' },
    });
    expect(await tax.lotBook({ userId: USER })).toMatchObject({ realizedUsd: null, trial: null });
  });
});

describe('the price door', () => {
  const SECRET = 'a-tax-basis-test-edge-secret-long-enough';
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-tax' });
  const caller = (scopes: string[]) => {
    const raw = encodePrincipal({
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'none',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-basis',
    });
  };

  it('needs tax:write and returns the version; the trial is a read', async () => {
    const router = createTaxRouter(service());
    const entry = { lotId: 'lot:d1:BTC', pricePerUnitUsd: '100', note: 'receipt' };
    await expect(router.createCaller(await caller(['tax:read'])).setLotBasis(entry)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const writer = router.createCaller(await caller(['tax:read', 'tax:write']));
    expect(await writer.setLotBasis(entry)).toEqual({ saved: true, version: 1 });
    expect((await writer.lotBook({ trial: { lotId: 'lot:d1:BTC', pricePerUnitUsd: '0.5' } })).realizedUsd).toBe('499.5');
    await expect(writer.setLotBasis({ ...entry, lotId: 'lot:b1:BTC' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a zero, negative, numeric or over-precise price, and a long note, at the door', async () => {
    const writer = createTaxRouter(service()).createCaller(await caller(['tax:write']));
    for (const price of ['0', '-1', '1.0000000000000000001', 100 as never]) {
      await expect(writer.setLotBasis({ lotId: 'lot:d1:BTC', pricePerUnitUsd: price, note: '' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    await expect(writer.setLotBasis({ lotId: 'lot:d1:BTC', pricePerUnitUsd: '1', note: 'x'.repeat(201) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
