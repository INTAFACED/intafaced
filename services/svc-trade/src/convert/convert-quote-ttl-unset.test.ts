/**
 * Unit card — convertQuoteTtlMs refuse-closed (no invented 15000)
 *
 * 1. Promise: omitted / non-integer / non-positive TTL → trade.convert_quote_ttl_unset.
 *    Owner-explicit 15000 is a published number, not a git default.
 * 2. Break: constructor `?? 15_000` lets blank look published.
 * 3. Done bar: requireConvertQuoteTtlMs before quote bind; source has no `?? 15_000`.
 * 4. Class M
 * 5. Paths: quote.ts requireConvertQuoteTtlMs; trade-service.ts ctor
 * 6. RED: unset helper returns 15000 or source git-defaults it
 */
import { describe, expect, it } from 'vitest';
import { requireConvertQuoteTtlMs } from './quote.js';

describe('unpublished convert quote TTL', () => {
  it('unset / NaN / 0 refuse TTL — never invent 15000', () => {
    for (const value of [undefined, null, Number.NaN, 0, 1.5] as const) {
      try {
        requireConvertQuoteTtlMs(value);
        expect.unreachable('expected refuse');
      } catch (err) {
        expect(err).toMatchObject({ code: 'trade.convert_quote_ttl_unset' });
      }
    }
  });

  it('owner-published 15000 is the TTL', () => {
    expect(requireConvertQuoteTtlMs(15_000)).toBe(15_000);
  });
});
