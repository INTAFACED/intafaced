import { describe, expect, it } from 'vitest';
import { ledgerHoldingsHistoryInputSchema, ledgerHoldingsHistorySchema, ledgerMovementSchema } from './ledger-holdings-history.js';

const ASK = { ownerType: 'user', ownerId: '81111111-1111-4111-8111-111111111111', from: '2026-10-01T00:00:00Z', bucketSeconds: 60 };

describe('ledger holdings history contract', () => {
  it('takes an owner, an ISO start and one of the bucket sizes', () => {
    expect(ledgerHoldingsHistoryInputSchema.safeParse(ASK).success).toBe(true);
    expect(ledgerHoldingsHistoryInputSchema.safeParse({ ...ASK, bucketSeconds: 86_400 }).success).toBe(true);
    expect(ledgerHoldingsHistoryInputSchema.safeParse({ ...ASK, bucketSeconds: 120 }).success).toBe(false);
    expect(ledgerHoldingsHistoryInputSchema.safeParse({ ...ASK, from: '2026-10-01' }).success).toBe(false);
  });

  it('reads only a customer or a Space, and refuses an unknown key', () => {
    expect(ledgerHoldingsHistoryInputSchema.safeParse({ ...ASK, ownerType: 'house' }).success).toBe(false);
    expect(ledgerHoldingsHistoryInputSchema.safeParse({ ...ASK, kind: 'available' }).success).toBe(false);
  });

  it('carries inflow, outflow and fee as unsigned decimal strings and the bucket as an ISO time', () => {
    const row = {
      assetId: 'BTC',
      module: 'trade',
      reason: 'trade.fill',
      bucketStart: '2026-10-01T00:00:00.000Z',
      inflow: '0.5',
      outflow: '0',
      fee: '0.001',
    };
    expect(ledgerMovementSchema.safeParse(row).success).toBe(true);
    expect(ledgerMovementSchema.safeParse({ ...row, fee: '-1' }).success).toBe(false);
    expect(ledgerMovementSchema.safeParse({ ...row, outflow: '-0.5' }).success).toBe(false);
    expect(ledgerMovementSchema.safeParse({ ...row, inflow: 1 }).success).toBe(false);
    expect(ledgerMovementSchema.safeParse({ ...row, bucketStart: 'garbage' }).success).toBe(false);
  });

  it('answers an owner with nothing as empty lists, not zero rows', () => {
    const empty = { asOf: '2026-10-24T12:00:00.000Z', from: '2026-10-24T00:00:00.000Z', bucketSeconds: 60, holdings: [], movements: [] };
    const out = ledgerHoldingsHistorySchema.parse(empty);
    expect(out.holdings).toEqual([]);
    expect(out.movements).toEqual([]);
    expect(ledgerHoldingsHistorySchema.safeParse({ ...empty, bucketSeconds: 0 }).success).toBe(false);
  });
});
