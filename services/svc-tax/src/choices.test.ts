import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createMemoryChoiceStore as memoryChoices, NO_CHOICES, saleRules, type CostBasisChoices } from './choices.js';
import {
  TAX_BASIS_STORE_UNWIRED,
  TAX_CHOICES_UNAVAILABLE,
  TAX_DATA_LAKE_UNAVAILABLE,
  TAX_INDEXER_UNAVAILABLE,
  TAX_LOT_PICK_INVALID,
  TAX_LOT_PICK_UNUSABLE,
} from './codes.js';
import type { TaxLedgerReads } from './ledger-reads.js';
import type { Fill } from './lot-book.js';
import { runLotEngine, type EngineDispose, type EngineMovement } from './lot-engine.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

// Every figure here is hand-computed TEST data, not a real balance.
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
const sale = (txId: string, day: number, assetId = 'BTC'): EngineDispose => ({
  side: 'dispose',
  txId,
  postedAt: at(day),
  assetId,
  qty: amt('1'),
  proceedsUsd: amt('300'),
});

describe('which method a sale uses', () => {
  const choices: CostBasisChoices = {
    accountMethod: 'LIFO',
    assetMethods: new Map([['ETH', 'HIFO']]),
    days: [
      { day: '2026-10-05', assetId: 'BTC', method: 'AVERAGE' },
      { day: '2026-10-05', assetId: null, method: 'FIFO' },
      { day: '2026-10-06', assetId: null, method: 'HIFO' },
    ],
    picks: [{ saleTxId: 's9', assetId: 'BTC', lotId: 'lot:b1:BTC' }],
    includeTransfers: null,
  };
  const rule = saleRules(choices, 'FIFO', null);

  it('most specific first: coin on that day, every coin that day, the coin, the account, then the default', () => {
    expect(rule(sale('s1', 5))).toMatchObject({ method: 'AVERAGE', source: 'day' });
    expect(rule(sale('s2', 5, 'ETH'))).toMatchObject({ method: 'FIFO', source: 'day' });
    expect(rule(sale('s3', 6, 'ETH'))).toMatchObject({ method: 'HIFO', source: 'day' });
    expect(rule(sale('s4', 7, 'ETH'))).toMatchObject({ method: 'HIFO', source: 'asset' });
    expect(rule(sale('s5', 7))).toMatchObject({ method: 'LIFO', source: 'account' });
    expect(saleRules(NO_CHOICES, 'FIFO', null)(sale('s6', 7))).toMatchObject({ method: 'FIFO', source: 'default' });
  });

  it('a pick rides along with whatever method the sale has; a preview applies one method and no pick', () => {
    expect(rule(sale('s9', 7))).toMatchObject({ method: 'LIFO', lotId: 'lot:b1:BTC' });
    expect(saleRules(choices, 'FIFO', 'HIFO')(sale('s9', 5))).toEqual({ method: 'HIFO', source: 'preview' });
  });
});

describe('a picked lot in the engine', () => {
  const buy = (txId: string, day: number, cost: string): EngineMovement => ({
    side: 'acquire',
    txId,
    postedAt: at(day),
    assetId: 'BTC',
    qty: amt('1'),
    costUsd: amt(cost),
    source: 'trade',
    reason: 'trade.fill',
    valuedAt: null,
  });
  const history = [buy('b1', 1, '100'), buy('b2', 2, '200'), buy('b3', 3, '150'), sale('s1', 4)];

  it('is drawn first, whatever the method; the other sales keep their method', () => {
    const run = runLotEngine([...history, sale('s2', 5)], (s) =>
      s.txId === 's1' ? { method: 'FIFO', lotId: 'lot:b2:BTC', source: 'account' } : { method: 'FIFO', source: 'account' },
    );
    const [later, first] = run.sales; // newest first
    expect(first).toMatchObject({ txId: 's1', pickedLotId: 'lot:b2:BTC', realizedUsd: amt('100') });
    // s2 by FIFO takes the oldest lot still open: b1 at 100.
    expect(later).toMatchObject({ txId: 's2', pickedLotId: null, realizedUsd: amt('200') });
  });

  it('a pick bigger than its lot takes the lot, then the method for the rest', () => {
    const two: EngineDispose = { ...sale('s1', 4), qty: amt('2'), proceedsUsd: amt('600') };
    const run = runLotEngine([...history.slice(0, 3), two], () => ({ method: 'LIFO', lotId: 'lot:b1:BTC', source: 'account' }));
    expect(run.sales[0]!.matches.map((m) => m.lotId)).toEqual(['lot:b1:BTC', 'lot:b3:BTC']);
    expect(run.sales[0]!.costUsd).toBe(amt('250'));
  });

  it('a lot that is no longer open is named, and the method decides', () => {
    const run = runLotEngine(history, () => ({ method: 'HIFO', lotId: 'lot:gone:BTC', source: 'account' }));
    expect(run.sales[0]).toMatchObject({ pickedLotId: null, realizedUsd: amt('100') });
    expect(run.residuals).toContain(TAX_LOT_PICK_UNUSABLE);
  });
});

/** TEST fills: buy 1 BTC at 100 (day 1), buy 1 at 200 (day 2), sell 1 for 300 (day 3). The caller holds 1. */
const fills: Fill[] = [
  { txId: 'b1', postedAt: at(1), received: { assetId: 'BTC', amount: amt('1') }, paid: { assetId: 'USDT', amount: amt('100') } },
  { txId: 'b2', postedAt: at(2), received: { assetId: 'BTC', amount: amt('1') }, paid: { assetId: 'USDT', amount: amt('200') } },
  { txId: 's1', postedAt: at(3), received: { assetId: 'USDT', amount: amt('300') }, paid: { assetId: 'BTC', amount: amt('1') } },
];
function reads(byUser: Record<string, Fill[]> = { [USER]: fills }): TaxLedgerReads {
  return {
    balances: async (_owner, userId) =>
      byUser[userId]
        ? [{ account: { ownerType: 'user', ownerId: userId, assetId: 'BTC', kind: 'available' }, accountId: 'a', amount: amt('1') }]
        : [],
    history: async () => [],
    tradeFills: async (userId) => ({ fills: byUser[userId] ?? [], truncated: false, outsideInflows: new Set(), inflows: [] }),
  };
}
const service = (choices = memoryChoices(), r = reads()) =>
  new TaxService({
    mapRaw: '',
    reads: r,
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    choices,
  });

describe('the lot book applies what the customer saved', () => {
  it('the account method changes the result and what is left; a coin method overrides it', async () => {
    const tax = service();
    expect((await tax.lotBook({ userId: USER })).realizedUsd).toBe('200'); // FIFO by default
    await tax.setLotMethod({ userId: USER, assetId: null, method: 'LIFO' });
    const lifo = await tax.lotBook({ userId: USER });
    expect(lifo).toMatchObject({ method: 'LIFO', preview: false, realizedUsd: '100' });
    expect(lifo.sales[0]).toMatchObject({ method: 'LIFO', methodSource: 'account' });
    expect(lifo.assets.find((a) => a.assetId === 'BTC')?.openCostUsd).toBe('100');
    await tax.setLotMethod({ userId: USER, assetId: 'BTC', method: 'AVERAGE' });
    const avg = await tax.lotBook({ userId: USER });
    expect(avg).toMatchObject({ method: 'LIFO', realizedUsd: '150' });
    expect(avg.sales[0]).toMatchObject({ method: 'AVERAGE', methodSource: 'asset' });
    expect(avg.choices).toEqual({
      status: 'saved',
      accountMethod: 'LIFO',
      assetMethods: [{ assetId: 'BTC', method: 'AVERAGE' }],
      days: [],
      picks: [],
      includeTransfers: null,
    });
    // A preview shows one method for everything and changes nothing saved.
    const preview = await tax.lotBook({ userId: USER, method: 'HIFO' });
    expect(preview).toMatchObject({ method: 'HIFO', preview: true, realizedUsd: '100' });
    expect(preview.sales[0]).toMatchObject({ methodSource: 'preview' });
    expect((await tax.lotBook({ userId: USER })).realizedUsd).toBe('150');
    // Clearing goes back: the coin follows the account, the account the default.
    await tax.setLotMethod({ userId: USER, assetId: 'BTC', method: null });
    await tax.setLotMethod({ userId: USER, assetId: null, method: null });
    expect(await tax.lotBook({ userId: USER })).toMatchObject({ method: 'FIFO', realizedUsd: '200' });
  });

  it('a day method applies to that day only', async () => {
    const tax = service();
    await tax.setDayMethod({ userId: USER, day: '2026-10-03', assetId: null, method: 'HIFO' });
    const book = await tax.lotBook({ userId: USER });
    expect(book.sales[0]).toMatchObject({ method: 'HIFO', methodSource: 'day', realizedUsd: '100' });
    await tax.setDayMethod({ userId: USER, day: '2026-10-04', assetId: null, method: 'HIFO' });
    await tax.setDayMethod({ userId: USER, day: '2026-10-03', assetId: null, method: null });
    expect((await tax.lotBook({ userId: USER })).sales[0]).toMatchObject({ method: 'FIFO', methodSource: 'default' });
  });

  it('a pick uses that lot for that sale, and is checked against the caller’s own book', async () => {
    const tax = service(memoryChoices(), reads({ [USER]: fills, [OTHER]: fills }));
    await tax.pickSaleLot({ userId: USER, saleTxId: 's1', assetId: 'BTC', lotId: 'lot:b2:BTC' });
    const book = await tax.lotBook({ userId: USER });
    expect(book.sales[0]).toMatchObject({ pickedLotId: 'lot:b2:BTC', realizedUsd: '100', method: 'FIFO' });
    // Another customer's book is untouched by this customer's pick.
    expect((await tax.lotBook({ userId: OTHER })).sales[0]).toMatchObject({ pickedLotId: null, realizedUsd: '200' });
    // A sale or lot not in the book, a lot of another coin, or one that is not the caller's: refused, nothing stored.
    for (const bad of [
      { saleTxId: 'nope', assetId: 'BTC', lotId: 'lot:b1:BTC' },
      { saleTxId: 's1', assetId: 'BTC', lotId: 'lot:zz:BTC' },
      { saleTxId: 's1', assetId: 'ETH', lotId: 'lot:b1:BTC' },
    ]) {
      await expect(tax.pickSaleLot({ userId: USER, ...bad })).rejects.toMatchObject({ code: TAX_LOT_PICK_INVALID });
    }
    const loner = service(memoryChoices(), reads({ [USER]: fills }));
    await expect(loner.pickSaleLot({ userId: OTHER, saleTxId: 's1', assetId: 'BTC', lotId: 'lot:b1:BTC' })).rejects.toMatchObject({
      code: TAX_LOT_PICK_INVALID,
    });
    await tax.pickSaleLot({ userId: USER, saleTxId: 's1', assetId: 'BTC', lotId: null });
    expect((await tax.lotBook({ userId: USER })).sales[0]).toMatchObject({ pickedLotId: null, realizedUsd: '200' });
  });

  it('a sale matched at the average cost takes no pick: it would change no figure', async () => {
    const tax = service();
    await tax.setLotMethod({ userId: USER, assetId: 'BTC', method: 'AVERAGE' });
    await expect(tax.pickSaleLot({ userId: USER, saleTxId: 's1', assetId: 'BTC', lotId: 'lot:b2:BTC' })).rejects.toMatchObject({
      code: TAX_LOT_PICK_INVALID,
    });
    expect((await tax.lotBook({ userId: USER })).choices).toMatchObject({ picks: [] });
  });

  it('a lot that arrived after the sale cannot be picked for it', async () => {
    const late: Fill = { ...fills[1]!, txId: 'b9', postedAt: at(9) };
    const tax = service(memoryChoices(), reads({ [USER]: [...fills, late] }));
    await expect(tax.pickSaleLot({ userId: USER, saleTxId: 's1', assetId: 'BTC', lotId: 'lot:b9:BTC' })).rejects.toMatchObject({
      code: TAX_LOT_PICK_INVALID,
    });
  });

  it('a lot already used up by an earlier sale cannot be picked for a later one', async () => {
    // TEST: a third buy and a second sale. FIFO: s1 (day 3) uses all of b1, so b1 is gone by s2 (day 5).
    const more: Fill[] = [
      ...fills,
      { txId: 's2', postedAt: at(5), received: { assetId: 'USDT', amount: amt('250') }, paid: { assetId: 'BTC', amount: amt('1') } },
      { txId: 'b3', postedAt: at(4), received: { assetId: 'BTC', amount: amt('1') }, paid: { assetId: 'USDT', amount: amt('150') } },
    ];
    const tax = service(memoryChoices(), reads({ [USER]: more }));
    await expect(tax.pickSaleLot({ userId: USER, saleTxId: 's2', assetId: 'BTC', lotId: 'lot:b1:BTC' })).rejects.toMatchObject({
      code: TAX_LOT_PICK_INVALID,
    });
    await tax.pickSaleLot({ userId: USER, saleTxId: 's2', assetId: 'BTC', lotId: 'lot:b3:BTC' });
    expect((await tax.lotBook({ userId: USER })).sales.find((x) => x.txId === 's2')).toMatchObject({
      pickedLotId: 'lot:b3:BTC',
      realizedUsd: '100',
    });
  });

  it('when the saved choices cannot be read, the book still answers with the default and says so', async () => {
    const broken = { ...memoryChoices(), read: async () => Promise.reject(new Error('connection refused')) };
    const book = await service(broken).lotBook({ userId: USER });
    expect(book).toMatchObject({ method: 'FIFO', realizedUsd: '200', choices: { status: 'unavailable', code: TAX_CHOICES_UNAVAILABLE } });
  });

  it('with no settings store the book still answers with the default, says so, and a save is refused by name', async () => {
    const tax = new TaxService({
      mapRaw: '',
      reads: reads(),
      lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
      indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    });
    expect(await tax.lotBook({ userId: USER })).toMatchObject({
      method: 'FIFO',
      choices: { status: 'unwired', code: TAX_BASIS_STORE_UNWIRED },
    });
    await expect(tax.setLotMethod({ userId: USER, assetId: null, method: 'LIFO' })).rejects.toMatchObject({
      code: TAX_BASIS_STORE_UNWIRED,
    });
    await expect(tax.setDayMethod({ userId: USER, day: '2026-10-03', assetId: null, method: 'HIFO' })).rejects.toMatchObject({
      code: TAX_BASIS_STORE_UNWIRED,
    });
    await expect(tax.pickSaleLot({ userId: USER, saleTxId: 's1', assetId: 'BTC', lotId: 'lot:b1:BTC' })).rejects.toMatchObject({
      code: TAX_BASIS_STORE_UNWIRED,
    });
  });
});

describe('the settings doors', () => {
  const SECRET = 'a-tax-choices-test-edge-secret-long-enough';
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
      id: 'req-choices',
    });
  };

  it('need tax:write; a reader is refused, and the saved choice is the caller’s own', async () => {
    const tax = service();
    const router = createTaxRouter(tax);
    await expect(router.createCaller(await caller(['tax:read'])).setLotMethod({ assetId: null, method: 'LIFO' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const writer = router.createCaller(await caller(['tax:read', 'tax:write']));
    expect(await writer.setLotMethod({ assetId: 'BTC', method: 'LIFO' })).toEqual({ saved: true });
    expect(await writer.setDayMethod({ day: '2026-10-03', assetId: null, method: 'HIFO' })).toEqual({ saved: true });
    expect(await writer.pickSaleLot({ saleTxId: 's1', assetId: 'BTC', lotId: 'lot:b2:BTC' })).toEqual({ saved: true });
    const book = await writer.lotBook();
    expect(book.choices).toMatchObject({ status: 'saved', assetMethods: [{ assetId: 'BTC', method: 'LIFO' }] });
    expect(book.sales[0]).toMatchObject({ method: 'HIFO', methodSource: 'day', pickedLotId: 'lot:b2:BTC' });
  });

  it('refuse a malformed coin, day or method at the door', async () => {
    const writer = createTaxRouter(service()).createCaller(await caller(['tax:write']));
    await expect(writer.setLotMethod({ assetId: 'btc;', method: 'LIFO' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(writer.setDayMethod({ day: '2026-02-30', assetId: null, method: 'LIFO' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(writer.setLotMethod({ assetId: null, method: 'LOFO' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
