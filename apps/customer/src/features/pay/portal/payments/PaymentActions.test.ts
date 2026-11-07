import { describe, expect, it } from 'vitest';
import { bulkBatchId } from './PaymentActions';

describe('bulk refund batch id (J-merchant-06 #7)', () => {
  const merchant = '11111111-1111-4111-8111-111111111111';
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('is a business key: the same business and payments name the same batch, in any order, after any reload', async () => {
    const first = await bulkBatchId(merchant, [a, b]);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await bulkBatchId(merchant, [b, a])).toBe(first);
    expect(await bulkBatchId(merchant.toUpperCase(), [a.toUpperCase(), b])).toBe(first);
  });

  it('another selection or another business is another batch', async () => {
    const first = await bulkBatchId(merchant, [a, b]);
    expect(await bulkBatchId(merchant, [a])).not.toBe(first);
    expect(await bulkBatchId('22222222-2222-4222-8222-222222222222', [a, b])).not.toBe(first);
  });
});
