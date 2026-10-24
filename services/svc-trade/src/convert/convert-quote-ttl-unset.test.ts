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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requireConvertQuoteTtlMs } from './quote.js';
import { tradeServiceSource } from '../spot/trade-service/source.testkit.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('unpublished convert quote TTL', () => {
  it('trade-service.ts does not git-default 15000', () => {
    const src = tradeServiceSource();
    expect(src).not.toMatch(/options\.convertQuoteTtlMs\s*\?\?\s*15_000/);
    expect(src).not.toMatch(/options\.convertQuoteTtlMs\s*\?\?\s*15000/);
    expect(src).toMatch(/this\.convertQuoteTtlMs = options\.convertQuoteTtlMs \?\? null/);
    expect(src).toMatch(/requireConvertQuoteTtlMs\((?:this|svc)\.convertQuoteTtlMs\)/);
  });

  it('quote.ts refuses convert_quote_ttl_unset (never invent 15000)', () => {
    const src = readFileSync(join(HERE, 'quote.ts'), 'utf8');
    expect(src).toMatch(/trade\.convert_quote_ttl_unset/);
    expect(src).toMatch(/never invent 15000/);
  });

  it('index.ts passes TRADE_CONVERT_QUOTE_TTL_MS (does not drop the env)', () => {
    const src = readFileSync(join(HERE, '..', 'index.ts'), 'utf8');
    expect(src).toMatch(/convertQuoteTtlMs:\s*env\.TRADE_CONVERT_QUOTE_TTL_MS/);
  });

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
