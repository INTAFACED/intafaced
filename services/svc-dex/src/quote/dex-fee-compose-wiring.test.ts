import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dexFeeOwnerEnvComposeGapsClosed, dexInternalBookFeeBpsComposeWired } from './dex-fee-compose-wiring.js';

/** svc-dex's own env, parsed by env.ts at import as at boot. */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DEX_INTERNAL_BOOK_FEE_BPS', undefined);
  for (const [key, value] of Object.entries({ EDGE_PRINCIPAL_SECRET: 's'.repeat(32), ...overrides })) vi.stubEnv(key, value);
  return (await import('../env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('socket.dex-fee-source fleet compose wiring', () => {
  it('closes CLOB fee + settlement cost + internal-book fee compose gaps', () => {
    expect(dexFeeOwnerEnvComposeGapsClosed()).toBe(true);
  });

  it('compose pins empty internal-book fee (never invent 20)', async () => {
    expect(dexInternalBookFeeBpsComposeWired()).toBe(true);
    const compose = readFileSync(new URL('../../../../docker-compose.apps.yml', import.meta.url), 'utf8');
    expect(compose).toMatch(/DEX_INTERNAL_BOOK_FEE_BPS:\s*\$\{DEX_INTERNAL_BOOK_FEE_BPS:-\}/);
    expect(compose).not.toContain('DEX_INTERNAL_BOOK_FEE_BPS: ${DEX_INTERNAL_BOOK_FEE_BPS:-' + '20}');
    // env.ts invents no fee either: unset is unpublished, and an explicit one is the owner's.
    expect((await loadWith({})).DEX_INTERNAL_BOOK_FEE_BPS).toBeUndefined();
    expect((await loadWith({ DEX_INTERNAL_BOOK_FEE_BPS: '7' })).DEX_INTERNAL_BOOK_FEE_BPS).toBe(7);
  }, 20_000);
});
