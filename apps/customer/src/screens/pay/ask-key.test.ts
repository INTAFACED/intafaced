import { describe, expect, it } from 'vitest';
import { askExpiry, askKey } from './ServerRequests';

// J-pay-05 #1: the key of an ask is a business key, made from what is asked, so a retry is the same request.
describe('ask key', () => {
  const payer = '22222222-2222-4222-8222-222222222222';

  it('closes at the end of a whole UTC day, the same moment for every ask made that day', () => {
    expect(askExpiry(new Date('2026-11-06T00:00:01.000Z'), 7)).toBe('2026-11-13T23:59:59.000Z');
    expect(askExpiry(new Date('2026-11-06T23:59:58.000Z'), 7)).toBe('2026-11-13T23:59:59.000Z');
    expect(askExpiry(new Date('2026-11-06T10:00:00.000Z'), 1)).toBe('2026-11-07T23:59:59.000Z');
  });

  it('is the same for the same ask and different when anything asked differs', async () => {
    const expires = askExpiry(new Date('2026-11-06T10:00:00.000Z'), 7);
    const one = await askKey(payer, 'USDT', '12', 'Tickets, TEST', expires);
    expect(one).toMatch(/^ask:22222222-2222-4222-8222-222222222222:[0-9a-f]{16}$/);
    expect(one.length).toBeLessThanOrEqual(64);
    expect(await askKey(payer, 'USDT', '12', 'Tickets, TEST', expires)).toBe(one);
    for (const other of [
      await askKey(payer, 'USDC', '12', 'Tickets, TEST', expires),
      await askKey(payer, 'USDT', '13', 'Tickets, TEST', expires),
      await askKey(payer, 'USDT', '12', null, expires),
      await askKey(payer, 'USDT', '12', 'Tickets, TEST', askExpiry(new Date('2026-11-07T10:00:00.000Z'), 7)),
      await askKey('33333333-3333-4333-8333-333333333333', 'USDT', '12', 'Tickets, TEST', expires),
    ])
      expect(other).not.toBe(one);
  });
});
