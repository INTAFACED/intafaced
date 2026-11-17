import { describe, expect, it } from 'vitest';
import { accrueCommission, type FeeEvent } from './commission.js';
import { MemoryAccrualStore } from './accrual-store.js';

const PAYER = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';
const REF2 = '33333333-3333-4333-8333-333333333333';

describe('Slice B durable accrual store — no payout', () => {
  it('zero fee → zero rows stored (no invent)', async () => {
    const store = new MemoryAccrualStore();
    const fee: FeeEvent = {
      feeEventId: 'fee-zero',
      userId: PAYER,
      feeAmount: '0',
      asset: 'USDT',
      at: new Date('2026-08-07T12:00:00.000Z'),
    };
    const parent = new Map([[PAYER, REF]]);
    const rows = accrueCommission({
      fee,
      parent,
      tiers: [
        { hop: 0, rate: '0.130' },
        { hop: 1, rate: '0.07' },
      ],
    });
    expect(rows).toHaveLength(0);
    expect(await store.saveRows(rows)).toBe(0);
    expect(await store.listByFeeEvent('fee-zero')).toHaveLength(0);
  });

  it('fee event → decimal commission rows persist idempotently', async () => {
    const store = new MemoryAccrualStore();
    const fee: FeeEvent = {
      feeEventId: 'fee-1',
      userId: PAYER,
      feeAmount: '100',
      asset: 'USDT',
      at: new Date('2026-08-07T12:00:00.000Z'),
    };
    const parent = new Map([
      [PAYER, REF],
      [REF, REF2],
    ]);
    const rows = accrueCommission({
      fee,
      parent,
      tiers: [
        { hop: 0, rate: '0.130' },
        { hop: 1, rate: '0.07' },
      ],
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.commissionAmount === 'string')).toBe(true);

    expect(await store.saveRows(rows)).toBe(rows.length);
    expect(await store.saveRows(rows)).toBe(0); // idempotent retry
    const listed = await store.listByFeeEvent('fee-1');
    expect(listed).toHaveLength(rows.length);
    expect(listed[0]!.commissionAmount).toBe('13');
    // Default pool when fee omits sourceModule — legacy operator path only.
    expect(listed.every((r) => r.sourceModule === 'identity')).toBe(true);
  });

  it('persists producer sourceModule so payout can sweep the right fee pool', async () => {
    const store = new MemoryAccrualStore();
    const fee: FeeEvent = {
      feeEventId: 'fee-trade',
      userId: PAYER,
      feeAmount: '100',
      asset: 'USDT',
      sourceModule: 'trade',
      at: new Date('2026-08-07T12:00:00.000Z'),
    };
    const parent = new Map([[PAYER, REF]]);
    const rows = accrueCommission({
      fee,
      parent,
      tiers: [{ hop: 0, rate: '0.130' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceModule).toBe('trade');
    await store.saveRows(rows);
    const listed = await store.listByFeeEvent('fee-trade');
    expect(listed[0]!.sourceModule).toBe('trade');
  });

  it('listByBeneficiary is self-filter only — foreign id returns other rows not mixed', async () => {
    const store = new MemoryAccrualStore();
    const at = new Date('2026-08-07T12:00:00.000Z');
    await store.saveRows([
      {
        feeEventId: 'f1',
        beneficiaryId: REF,
        payerId: PAYER,
        hop: 0,
        rate: '0.130',
        feeAmount: '100',
        commissionAmount: '13',
        asset: 'USDT',
        accruedAt: at,
        sourceModule: 'trade',
      },
      {
        feeEventId: 'f2',
        beneficiaryId: REF2,
        payerId: PAYER,
        hop: 0,
        rate: '0.07',
        feeAmount: '100',
        commissionAmount: '7',
        asset: 'USDT',
        accruedAt: at,
        sourceModule: 'pay',
      },
    ]);
    const mine = await store.listByBeneficiary(REF, 100);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.beneficiaryId).toBe(REF);
    const theirs = await store.listByBeneficiary(REF2, 100);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.beneficiaryId).toBe(REF2);
    expect(await store.listByBeneficiary('00000000-0000-4000-8000-000000000000', 100)).toHaveLength(0);
  });
});
