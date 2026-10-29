import { describe, expect, it } from 'vitest';
import { confirmationDepth, railPayload } from './internal.js';

const at = new Date('2026-10-29T06:00:00.000Z');
const result = (status: string, raw: Record<string, unknown>) =>
  ({ ok: true, status, railRef: 'addr', amount: 60n, assetId: 'USDT', at, raw }) as unknown as Parameters<typeof railPayload>[0];

describe('the confirmation count a merchant reads while a crypto payment waits (J-merchant-05 #4)', () => {
  it('a pending rail result keeps how deep its transfer is and how deep it must be', () => {
    expect(railPayload(result('pending', { received: '60', missing: '40', required: 6, confirmations: 2 }))).toMatchObject({
      confirmations: 2,
      required: 6,
    });
  });

  it('keeps no count on any other result, or one out of range', () => {
    expect(railPayload(result('authorized', { required: 6, confirmations: 6 }))).not.toHaveProperty('confirmations');
    expect(railPayload(result('pending', { required: 6 }))).not.toHaveProperty('confirmations');
    expect(railPayload(result('pending', { required: 6, confirmations: -1 }))).not.toHaveProperty('confirmations');
    expect(confirmationDepth({ confirmations: 2, required: 0 })).toBeNull();
    expect(confirmationDepth({ confirmations: '2', required: 6 })).toBeNull();
    expect(confirmationDepth(null)).toBeNull();
    expect(confirmationDepth({ confirmations: 0, required: 6 })).toEqual({ seen: 0, required: 6 });
  });
});
