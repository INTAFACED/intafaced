/**
 * DEX_INTERNAL_BOOK_ENABLED off-words.
 *
 * Trim, then lowercase, then compare. `0`, `false`, `off`, `no`, and
 * `disabled` turn the custodial internal book off. Padding and case do not
 * keep it on. Unset stays on. A boolean false stays off. Empty and any other
 * string stay on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { loadEnv } from '@intafaced/config';

const SECRET = 's'.repeat(32);

async function loadSchema() {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('EDGE_PRINCIPAL_SECRET', SECRET);
  vi.stubEnv('DEX_INTERNAL_BOOK_ENABLED', ' false ');
  vi.stubEnv('DEX_INTERNAL_BOOK_FEE_BPS', undefined);
  vi.stubEnv('DEX_CLOB_FEE_BPS', undefined);
  vi.stubEnv('DEX_CLOB_SETTLEMENT_COST', undefined);
  const module = await import('./env.js');
  return module;
}

function readEnabled(schema: ZodTypeAny, enabled?: boolean | string): boolean {
  const source: Record<string, unknown> = {
    NODE_ENV: 'test',
    EDGE_PRINCIPAL_SECRET: SECRET,
  };
  if (enabled !== undefined) source.DEX_INTERNAL_BOOK_ENABLED = enabled;
  return loadEnv(schema, source).DEX_INTERNAL_BOOK_ENABLED;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DEX_INTERNAL_BOOK_ENABLED off words', () => {
  it('trimmed lowercase 0, false, off, no, and disabled are off, including padding and case', async () => {
    const loaded = await loadSchema();
    expect(loaded.env.DEX_INTERNAL_BOOK_ENABLED).toBe(false);

    const offWords = ['0', 'false', 'off', 'no', 'disabled', ' false ', 'FALSE', ' disabled ', 'OFF', ' No ', '  0  '];
    for (const word of offWords) {
      expect(readEnabled(loaded.schema, word), JSON.stringify(word)).toBe(false);
    }
  });

  it('unset defaults on; empty and other strings stay on', async () => {
    const loaded = await loadSchema();
    expect(readEnabled(loaded.schema)).toBe(true);

    for (const word of ['', '   ', 'true', 'yes', 'enabled']) {
      expect(readEnabled(loaded.schema, word), JSON.stringify(word)).toBe(true);
    }
  });

  it('boolean false stays off and boolean true stays on', async () => {
    const loaded = await loadSchema();
    expect(readEnabled(loaded.schema, false)).toBe(false);
    expect(readEnabled(loaded.schema, true)).toBe(true);
  });
});
