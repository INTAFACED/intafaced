/**
 * TEST FIXTURE ONLY (lead ruling D29(a)). Explicit SP-order-entry-03 owner
 * values wide enough that every order the existing trade tests place still
 * passes: a reference of 1,000,000,000 with a 100% band (so 0 to 2,000,000,000),
 * a reference that is never stale, caps of 1,000,000, and `cancel` correction.
 * These are not owner values and nothing in production reads this file.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { OrderEntryRules } from '../order-entry-rules.js';

export const TEST_ORDER_ENTRY_RULES: OrderEntryRules = {
  priceBand: {
    bandBps: 10_000,
    maxReferenceAgeMs: Number.MAX_SAFE_INTEGER,
    reference: { reference: async () => ({ price: parseAmount('1000000000'), at: new Date(0) }) },
  },
  openOrderCaps: { total: 1_000_000, byLevel: { none: 1_000_000, basic: 1_000_000, full: 1_000_000, institutional: 1_000_000 } },
  priceCorrection: { preferenceOf: async () => 'cancel' },
};
