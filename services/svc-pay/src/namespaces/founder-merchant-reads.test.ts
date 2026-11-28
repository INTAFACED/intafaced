import type { FounderMerchantSectionInput } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { SCALE } from '@intafaced/ledger-client';
import { scriptedSql } from '../scripted-sql.testkit.js';
import { concentrationShare, createFounderMerchantReads } from './founder-merchant-reads.js';

const MERCHANT = '11111111-1111-4111-8111-111111111111';

describe('concentration share', () => {
  it('truncates to the ledger scale and refuses an empty total', () => {
    expect(concentrationShare(SCALE / 2n, SCALE)).toBe('0.5');
    expect(concentrationShare(SCALE, SCALE)).toBe('1');
    // 2/3 truncated at the ledger scale. Rounding the next digit would be …667.
    expect(concentrationShare(2n, 3n)).toBe('0.666666666666666666');
    expect(concentrationShare(1n, 0n)).toBeNull();
    expect(concentrationShare(-1n, 10n)).toBeNull();
  });
});

describe('api key section', () => {
  it('does not read key material from this service', async () => {
    // The section answers "not configured" before it asks anything about keys: the only question is whether the
    // merchant exists.
    const { sql, calls } = scriptedSql<Sql>((call) => (call.text.includes('FROM pay.merchants') ? [{ id: MERCHANT }] : []));
    const reads = createFounderMerchantReads({ sql });
    await expect(
      reads.section('founder-1', { merchantId: MERCHANT, section: 'apiKeys', limit: 10 } as FounderMerchantSectionInput),
    ).resolves.toEqual({
      section: 'apiKeys',
      catalog: 'not_configured',
      items: [],
      nextCursor: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('FROM pay.merchants');
    for (const call of calls) expect(call.text).not.toMatch(/api_keys|signing_secret|key_hash|secret/);
  });
});
