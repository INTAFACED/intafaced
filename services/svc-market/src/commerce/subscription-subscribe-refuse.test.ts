import { describe, expect, it, vi } from 'vitest';
import { CommerceService } from './commerce-service.js';
import { MarketError } from '../vendor-service.js';

/**
 * Recurring subscribe must refuse BEFORE any write or ledger post.
 * One period is `purchase` + `marketPurchase`. This door is not a silent scheduler.
 */
describe('subscribe — refuse unbuilt recurring before any write', () => {
  it('refuses without touching sql, slots, or ledger', async () => {
    const sql = Object.assign(
      vi.fn(() => {
        throw new Error('sql must not run for unbuilt subscribe');
      }),
      { begin: vi.fn() },
    );
    const vendors = {
      myVendor: vi.fn(async () => {
        throw new Error('vendor lookup must not run for unbuilt subscribe');
      }),
      claimSlot: vi.fn(),
    };
    const ledger = { post: vi.fn(async () => ({ id: 'invented' })) };
    const commerce = new CommerceService(sql as never, vendors as never, ledger as never, { commissionBps: 500 });

    await expect(commerce.subscribe({ listingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })).rejects.toMatchObject({
      name: 'MarketError',
      code: 'market.subscription_recurring_not_built',
    });
    expect(sql).not.toHaveBeenCalled();
    expect(vendors.myVendor).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('refuses even when commission is configured (C3 is the gate, not the rate)', async () => {
    const ledger = { post: vi.fn() };
    const commerce = new CommerceService(vi.fn() as never, { myVendor: vi.fn() } as never, ledger as never, {
      commissionBps: 137,
    });
    await expect(commerce.subscribe()).rejects.toBeInstanceOf(MarketError);
    expect(ledger.post).not.toHaveBeenCalled();
  });
});
