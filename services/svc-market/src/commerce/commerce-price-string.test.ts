import { formatAmount, parseAmount, MemoryLedger, MoneyError } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { recordingSql } from '../sql-recorder.testkit.js';
import type { VendorService } from '../vendor-service.js';
import { decimalPriceFromDriver, purchasePriceTermsMatch } from './commerce-price.js';
import { CommerceService } from './commerce-service.js';

/**
 * Driver numeric must be a decimal string. String(0.1) is IEEE-rounded and
 * must not be parseAmount'd. claimPurchase must not terms-match on that float.
 */

describe('listing/purchase price is a decimal string', () => {
  it('proves the IEEE door: String(0.1) then parseAmount would coerce', () => {
    expect(String(0.1)).toBe('0.1');
    expect(formatAmount(parseAmount(String(0.1)))).toBe('0.1');
  });

  it('throws when the driver yields JS number 0.1 — does not coerce', () => {
    expect(() => decimalPriceFromDriver(0.1)).toThrow(MoneyError);
    expect(() => decimalPriceFromDriver(0.1)).toThrow(/decimal string, got number/);
  });

  it('accepts a decimal string and canonicalises', () => {
    expect(decimalPriceFromDriver('0.1')).toBe('0.1');
    expect(decimalPriceFromDriver('25.50')).toBe('25.5');
  });

  it('claimPurchase termsMatch does not match on rounded float 0.1', () => {
    expect(purchasePriceTermsMatch(0.1, '0.1')).toBe(false);
    expect(purchasePriceTermsMatch('0.1', '0.1')).toBe(true);
    expect(purchasePriceTermsMatch('0.10', '0.1')).toBe(true);
    expect(purchasePriceTermsMatch('0.2', '0.1')).toBe(false);
  });

  it('mappers and claimPurchase use the helper — never String(row.price)', async () => {
    const listingRow = (price: unknown) => ({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      vendor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'TEST',
      description: 'TEST',
      offer_type: 'one_time',
      asset_id: 'USDT',
      price,
      period_seconds: null,
      status: 'active',
      category: null,
      created_at: new Date('2026-10-23T00:00:00.000Z'),
      updated_at: new Date('2026-10-23T00:00:00.000Z'),
    });
    const service = (price: unknown) =>
      new CommerceService(recordingSql(() => [listingRow(price)]).sql, {} as VendorService, new MemoryLedger(), { commissionBps: 500 });
    // A driver number is refused, not rounded through String(); a decimal string is canonicalised.
    await expect(service(0.1).getListing('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).rejects.toThrow(MoneyError);
    await expect(service(0.1).getListing('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).rejects.toThrow(/decimal string, got number/);
    expect((await service('25.50').getListing('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))?.price).toBe('25.5');
    expect((await service('9007199254740993.000000000000000001').getListing('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))?.price).toBe(
      '9007199254740993.000000000000000001',
    );
  });
});
