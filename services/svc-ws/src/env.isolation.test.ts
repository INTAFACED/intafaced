import { describe, expect, it } from 'vitest';
import { FORBIDDEN_SERVICE_CREDENTIALS, SVC_WS_OWN_ENV_KEYS } from './env.js';

/**
 * Credential-isolation pin for svc-ws.
 *
 * Anonymous public feeds never use identity credentials. Optional JWT and
 * identity service authentication exist only for the two private doors; no
 * principal-signing key or database connection is declared.
 */
describe('svc-ws credential isolation', () => {
  it('documents the forbidden service credentials contract', () => {
    expect([...FORBIDDEN_SERVICE_CREDENTIALS]).toEqual(['INTERNAL_SERVICE_SECRET', 'EDGE_PRINCIPAL_SECRET', 'DATABASE_URL']);
  });

  it('does not declare forbidden credentials on the svc-ws own env shape', () => {
    const own = new Set<string>(SVC_WS_OWN_ENV_KEYS);
    for (const key of FORBIDDEN_SERVICE_CREDENTIALS) {
      expect(own.has(key)).toBe(false);
    }
  });

  it('declares private identity configuration separately from public feed configuration', () => {
    expect(SVC_WS_OWN_ENV_KEYS).toContain('IDENTITY_URL');
    expect(SVC_WS_OWN_ENV_KEYS).toContain('IDENTITY_OWNERSHIP_SECRET');
  });

  it('loads without forbidden keys present in process.env (schema does not require them)', async () => {
    // env.ts already loadEnv'd at import with whatever process.env has.
    // Assert the exported env object never grew those fields even if they were set.
    const { env } = await import('./env.js');
    for (const key of FORBIDDEN_SERVICE_CREDENTIALS) {
      expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
    }
    // Optional private-stream secret may or may not be set; public path must still exist.
    expect(typeof env.MATCHING_URL).toBe('string');
    expect(typeof env.TRADE_URL).toBe('string');
  });
});
