import { describe, expect, it } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount as amt, houseFees, userAvailable, recipes } from '../index.js';
import { marketListingFee, marketPremiumPlacement, marketPurchase } from './market.js';
import { InvalidEntryError } from '../types.js';

const BUYER = '11111111-1111-4111-8111-111111111111';
const VENDOR = '22222222-2222-4222-8222-222222222222';

describe('marketPurchase', () => {
  it('refuses non-integer / out-of-range bps', () => {
    expect(() =>
      marketPurchase({
        purchaseId: 'p1',
        listingId: 'l1',
        buyerId: BUYER,
        vendorUserId: VENDOR,
        assetId: 'USDT',
        price: amt('10'),
        commissionBps: 10_000,
      }),
    ).toThrow(InvalidEntryError);

    expect(() =>
      marketPurchase({
        purchaseId: 'p1',
        listingId: 'l1',
        buyerId: BUYER,
        vendorUserId: VENDOR,
        assetId: 'USDT',
        price: amt('10'),
        commissionBps: 1.5,
      }),
    ).toThrow(InvalidEntryError);
  });

  it('refuses a blank purchase identity before any post', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: BUYER,
        assetId: 'USDT',
        amount: amt('1000'),
        rail: 'test',
        railRef: 'seed-blank-ids',
      }),
    );
    const journalBefore = ledger.journal().length;

    const real = {
      purchaseId: 'p-real-ids',
      listingId: 'l1',
      buyerId: BUYER,
      vendorUserId: VENDOR,
      assetId: 'USDT',
      price: amt('10'),
      commissionBps: 250,
    };

    let posted = false;
    try {
      await ledger.post(marketPurchase({ ...real, buyerId: '   ' }));
      posted = true;
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEntryError);
      expect((err as Error).message).toMatch(/buyerId is required/);
    }
    expect(posted).toBe(false);
    expect(ledger.journal()).toHaveLength(journalBefore);
    expect(ledger.journal().some((tx) => tx.reason === 'market.purchase')).toBe(false);

    expect(() => marketPurchase({ ...real, vendorUserId: '' })).toThrow(/vendorUserId is required/);
    expect(() => marketPurchase({ ...real, assetId: '' })).toThrow(/assetId is required/);
    expect(() => marketPurchase({ ...real, listingId: '' })).toThrow(/listingId is required/);
    expect(ledger.journal()).toHaveLength(journalBefore);

    const tx = await ledger.post(marketPurchase(real));
    expect(tx.reason).toBe('market.purchase');
    expect(ledger.journal().filter((row) => row.reason === 'market.purchase')).toHaveLength(1);
    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('990');
  });

  it('refuses self-purchase', () => {
    expect(() =>
      marketPurchase({
        purchaseId: 'p1',
        listingId: 'l1',
        buyerId: BUYER,
        vendorUserId: BUYER,
        assetId: 'USDT',
        price: amt('10'),
        commissionBps: 250,
      }),
    ).toThrow(InvalidEntryError);
  });

  it('floors commission at scaled precision so buyer pays exactly the listed price', () => {
    // 100 * 333 bps = 3.33 exactly at 18dp; vendor 96.67. Floor vs ceil only
    // diverges on fractional wei — the invariant is buyer + parts balance.
    const req = marketPurchase({
      purchaseId: 'p-floor',
      listingId: 'l1',
      buyerId: BUYER,
      vendorUserId: VENDOR,
      assetId: 'USDT',
      price: amt('100'),
      commissionBps: 333,
    });
    expect(req.idempotencyKey).toBe('market.purchase:p-floor');
    expect(req.module).toBe('market');
    expect(req.reason).toBe('market.purchase');

    const buyerCredit = req.entries.find((e) => e.account.ownerId === BUYER && e.direction === 'credit');
    const vendorDebit = req.entries.find((e) => e.account.ownerId === VENDOR && e.direction === 'debit');
    const houseDebit = req.entries.find((e) => e.account.ownerType === 'house' && e.direction === 'debit');

    expect(formatAmount(buyerCredit!.amount)).toBe('100');
    expect(formatAmount(vendorDebit!.amount)).toBe('96.67');
    expect(formatAmount(houseDebit!.amount)).toBe('3.33');
    expect(buyerCredit!.amount).toBe(vendorDebit!.amount + houseDebit!.amount);
  });

  it('floor never invents a wei of house revenue beyond the bps share', () => {
    // 1 wei * 1 bps floors to 0 commission under floor; ceil would invent 1 wei.
    const req = marketPurchase({
      purchaseId: 'p-wei',
      listingId: 'l1',
      buyerId: BUYER,
      vendorUserId: VENDOR,
      assetId: 'USDT',
      price: 1n, // one scaled unit
      commissionBps: 1,
    });
    const houseDebit = req.entries.find((e) => e.account.ownerType === 'house');
    expect(houseDebit).toBeUndefined();
    expect(req.entries).toHaveLength(2);
  });

  it('allows zero commission when owner sets bps to 0 (explicit free)', () => {
    const req = marketPurchase({
      purchaseId: 'p-free',
      listingId: 'l1',
      buyerId: BUYER,
      vendorUserId: VENDOR,
      assetId: 'USDT',
      price: amt('50'),
      commissionBps: 0,
    });
    expect(req.entries).toHaveLength(2);
    expect(req.entries.some((e) => e.account.ownerType === 'house')).toBe(false);
  });

  it('posts once under the same purchaseId (ledger idempotency)', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: BUYER,
        assetId: 'USDT',
        amount: amt('1000'),
        rail: 'test',
        railRef: 'seed-1',
      }),
    );

    const body = {
      purchaseId: 'same-p',
      listingId: 'l1',
      buyerId: BUYER,
      vendorUserId: VENDOR,
      assetId: 'USDT',
      price: amt('100'),
      commissionBps: 500, // 5%
    };

    const first = await ledger.post(marketPurchase(body));
    const second = await ledger.post(marketPurchase(body));
    expect(second.id).toBe(first.id);

    expect(formatAmount((await ledger.balance(userAvailable(BUYER, 'USDT'))).amount)).toBe('900');
    expect(formatAmount((await ledger.balance(userAvailable(VENDOR, 'USDT'))).amount)).toBe('95');
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('5');
  });

  /**
   * Unit card A2 — commission conservation residual (Class M adversarial).
   * Promise: recipes/market.ts — "Vendor + house always sum exactly to the price".
   * Done bar: for a table of prices × bps, buyer credit = sum of debit legs; no dust.
   */
  it('vendor net + house commission always conserve the listed price (no dust leak)', () => {
    const prices = [1n, 3n, 7n, 999n, amt('0.01'), amt('99.99'), amt('1000'), amt('12345.678901234567')];
    const bpsList = [0, 1, 7, 250, 333, 500, 2500, 5000, 9998];
    for (const price of prices) {
      for (const commissionBps of bpsList) {
        let req;
        try {
          req = marketPurchase({
            purchaseId: `p-${price}-${commissionBps}`,
            listingId: 'l1',
            buyerId: BUYER,
            vendorUserId: VENDOR,
            assetId: 'USDT',
            price,
            commissionBps,
          });
        } catch (err) {
          // Extreme bps on tiny price may leave vendor with nothing — refuse, do not invent dust.
          expect(err).toBeInstanceOf(InvalidEntryError);
          continue;
        }
        const buyerCredit = req.entries.find((e) => e.account.ownerId === BUYER && e.direction === 'credit');
        const debitSum = req.entries.filter((e) => e.direction === 'debit').reduce((acc, e) => acc + e.amount, 0n);
        expect(buyerCredit!.amount).toBe(price);
        expect(debitSum).toBe(price);
      }
    }
  });
});

describe('marketListingFee (§8.7 · §13 unwired)', () => {
  it('refuses blank listingId / non-positive amount (no invent free fee post)', () => {
    expect(() => marketListingFee({ listingId: '  ', vendorUserId: VENDOR, assetId: 'USDT', amount: amt('1') })).toThrow(InvalidEntryError);
    expect(() => marketListingFee({ listingId: 'l1', vendorUserId: VENDOR, assetId: 'USDT', amount: 0n })).toThrow(InvalidEntryError);
  });

  it('posts vendor → houseFees(market) once under listingId', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: VENDOR,
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'test',
        railRef: 'vendor-seed',
      }),
    );

    const body = {
      listingId: 'listing-fee-1',
      vendorUserId: VENDOR,
      assetId: 'USDT',
      amount: amt('5'),
    };
    const req = marketListingFee(body);
    expect(req.idempotencyKey).toBe('market.listing_fee:listing-fee-1');
    expect(req.reason).toBe('market.listing_fee');
    expect(req.meta?.socket).toBe('§13');

    const first = await ledger.post(req);
    const second = await ledger.post(marketListingFee(body));
    expect(second.id).toBe(first.id);
    expect(formatAmount((await ledger.balance(userAvailable(VENDOR, 'USDT'))).amount)).toBe('95');
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('5');
  });
});

describe('marketPremiumPlacement (§8.7 · §13 unwired)', () => {
  it('keys on placementId so one listing can buy placement more than once', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: VENDOR,
        assetId: 'USDT',
        amount: amt('50'),
        rail: 'test',
        railRef: 'vendor-seed-2',
      }),
    );

    await ledger.post(
      marketPremiumPlacement({
        placementId: 'place-a',
        listingId: 'l1',
        vendorUserId: VENDOR,
        assetId: 'USDT',
        amount: amt('10'),
      }),
    );
    await ledger.post(
      marketPremiumPlacement({
        placementId: 'place-b',
        listingId: 'l1',
        vendorUserId: VENDOR,
        assetId: 'USDT',
        amount: amt('10'),
      }),
    );

    expect(formatAmount((await ledger.balance(userAvailable(VENDOR, 'USDT'))).amount)).toBe('30');
    expect(formatAmount((await ledger.balance(houseFees('market', 'USDT'))).amount)).toBe('20');
  });

  it('refuses blank placementId', () => {
    expect(() =>
      marketPremiumPlacement({
        placementId: '',
        listingId: 'l1',
        vendorUserId: VENDOR,
        assetId: 'USDT',
        amount: amt('1'),
      }),
    ).toThrow(InvalidEntryError);
  });
});
