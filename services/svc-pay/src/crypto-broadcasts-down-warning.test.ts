import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 0004's reversal drops pay.crypto_broadcasts. That table holds the signed raw
 * transaction journal in `signed_raw` (0012). The ledger does not store that
 * mapping, so the down file must carry the same live-row warning as 0000 and
 * 0001 and must still drop the table.
 */
const here = dirname(fileURLToPath(import.meta.url));
const down = readFileSync(join(here, '../drizzle/0004_pay_crypto_broadcasts.down.sql'), 'utf8');

describe('0004 crypto_broadcasts down warning', () => {
  it('warns it must never run against live rows and still drops pay.crypto_broadcasts', () => {
    expect(down).toMatch(/intafaced:destructive/);
    expect(down).toMatch(/scratch\n-- schema \(§14\)/);
    expect(down).toMatch(/must NEVER run against live rows/);
    expect(down).toMatch(/signed_raw/);
    expect(down).toMatch(/not recoverable from the ledger/);
    expect(down).toContain('DROP INDEX IF EXISTS "pay"."crypto_broadcasts_updated_idx";');
    expect(down).toContain('DROP TABLE IF EXISTS "pay"."crypto_broadcasts";');
  });
});
