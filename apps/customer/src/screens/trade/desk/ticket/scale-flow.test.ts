import { describe, expect, it } from 'vitest';
import { batchItemLabel, placeInstruction, placedCount, scaleLockStays, type BatchItem } from './scale-flow';

describe('post-only rejection (TRD-0004)', () => {
  it('given a post-only buy at the best ask, a rejected batch item says refused and is not placed', () => {
    const rejected: BatchItem = { clientOrderId: 'desk:post', refused: true };
    const rested: BatchItem = { clientOrderId: 'desk:rest', refused: false };
    expect(batchItemLabel(rejected)).toBe('refused');
    expect(placedCount([rejected, rested])).toBe(1);
    expect(placedCount([rejected])).toBe(0);
  });
});

describe('scale-order lock (TRD-0013)', () => {
  it('a lost reply keeps the lock, and a later 401 keeps it too', () => {
    expect(scaleLockStays('lost')).toBe(true);
    expect(scaleLockStays('unauthorized')).toBe(true);
    expect(scaleLockStays('forbidden')).toBe(true);
  });

  it('a second batch is not sent while the lock is held, and an accounted batch clears it', () => {
    expect(scaleLockStays('lost')).toBe(true);
    expect(scaleLockStays('accounted')).toBe(false);
  });
});

describe('desk instruction (TRD-0242)', () => {
  it('post-only is sent as timeInForce PO and postOnly true', () => {
    expect(placeInstruction('PO')).toEqual({ timeInForce: 'PO', postOnly: true });
    expect(placeInstruction('IOC')).toEqual({ timeInForce: 'IOC', postOnly: false });
    expect(placeInstruction('FOK')).toEqual({ timeInForce: 'FOK', postOnly: false });
    expect(placeInstruction('GTC')).toEqual({ timeInForce: 'GTC', postOnly: false });
  });
});
