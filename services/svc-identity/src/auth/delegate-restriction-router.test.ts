import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { createApiKeyIpRouter } from '../api-key-ip-router.js';
import { createApiKeyExpireRouter } from '../api-key-expire-router.js';
import { createApiKeyOriginRouter } from '../api-key-origin-router.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import type { ApiKeyFactorGate } from './api-key-fresh-factor.js';

const userId = '11111111-1111-4111-8111-111111111111';
const keyId = '22222222-2222-4222-8222-222222222222';
const tokenConfig = {
  secret: 'delegate-restriction-test-only-token-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

describe('delegated keys cannot remove their access restrictions', () => {
  it.each(['ip', 'origin'] as const)('refuses delegated %s removal before any database read or write', async (kind) => {
    let reads = 0;
    const sql = (async () => {
      reads += 1;
      throw new Error('delegated removal reached storage');
    }) as unknown as Sql;
    const minter = {} as ApiKeyMinter;
    const { token } = await issueAccessToken(
      { userId, sessionId: '33333333-3333-4333-8333-333333333333', scopes: ['identity:write'], apiKeyId: keyId },
      tokenConfig,
    );
    const context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'delegate-fixture' };
    const result =
      kind === 'ip'
        ? createApiKeyIpRouter(sql, minter, {} as ApiKeyFactorGate)
            .createCaller(context)
            .unbindApiKeyIpAllowlist({ keyId, ip: '127.0.0.1' })
        : createApiKeyOriginRouter(sql, minter, {} as ApiKeyFactorGate)
            .createCaller(context)
            .unbindApiKeyOriginAllowlist({ keyId, origin: 'app.example.com' });
    await expect(result).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'auth.delegate_cannot_grant' } });
    expect(reads).toBe(0);
  });
});

describe('a delegated key cannot change any key expiry', () => {
  it('refuses before any database read or write', async () => {
    let reads = 0;
    const sql = (async () => {
      reads += 1;
      throw new Error('delegated expiry change reached storage');
    }) as unknown as Sql;
    const { token } = await issueAccessToken(
      { userId, sessionId: '33333333-3333-4333-8333-333333333333', scopes: ['identity:write'], apiKeyId: keyId },
      tokenConfig,
    );
    const context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'delegate-fixture' };
    await expect(
      createApiKeyExpireRouter(sql, {} as ApiKeyFactorGate)
        .createCaller(context)
        .expireApiKey({ keyId, expiresAt: '2099-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'auth.delegate_cannot_grant' } });
    expect(reads).toBe(0);
  });
});
