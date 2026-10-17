import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCALE } from '@intafaced/ledger-client';
import { concentrationShare } from './founder-merchant-reads.js';

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
  it('does not read key material from this service', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'founder-merchant-reads.ts'), 'utf8');
    const body = src.slice(src.indexOf("case 'apiKeys'"), src.indexOf("case 'webhooks'"));
    expect(body).toContain("catalog: 'not_configured'");
    expect(body).not.toMatch(/api_keys|signing_secret|key_hash|secret/);
  });
});
