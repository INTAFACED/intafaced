import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { streamTokenAudience } from '@intafaced/contracts/stream-token';
import { mintStreamToken, parseStreamTokenTtl, StreamTokenError } from './stream-token.js';

// J-developer-09 #2: the stream token is cut from the key's own exchanged principal and grants no more than it.

const tokens: TokenConfig = {
  secret: 'test-access-secret-at-least-32-chars!!',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function keyPrincipal(extra: { subAccountId?: string; apiKeyId?: string | null; ttl?: number } = {}): Promise<Principal> {
  const { token } = await issueAccessToken(
    {
      userId: USER,
      sessionId: KEY,
      scopes: ['trade:read', 'trade:write'],
      tier: 'basic',
      ...(extra.apiKeyId === null ? {} : { apiKeyId: extra.apiKeyId ?? KEY, keyEnv: 'live' as const }),
      ...(extra.subAccountId ? { subAccountId: extra.subAccountId } : {}),
    },
    { ...tokens, accessTtlSeconds: extra.ttl ?? 900 },
  );
  return verifyAccessToken(token, tokens);
}

async function refusal(promise: Promise<unknown>): Promise<StreamTokenError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StreamTokenError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('parseStreamTokenTtl', () => {
  it('reads whole seconds from 1 to 3600, blank as unset, and stops the boot on anything else', () => {
    expect(parseStreamTokenTtl('')).toBeNull();
    expect(parseStreamTokenTtl(undefined)).toBeNull();
    expect(parseStreamTokenTtl(' 20 ')).toBe(20);
    for (const bad of ['0', '3601', '1.5', '-1', 'twenty'])
      expect(() => parseStreamTokenTtl(bad)).toThrow(/IDENTITY_STREAM_TOKEN_TTL_SECONDS/);
  });
});

describe('mintStreamToken', () => {
  it('a blank lifetime refuses with the typed code', async () => {
    const err = await refusal(mintStreamToken({ principal: await keyPrincipal(), ttlSeconds: null, tokens }));
    expect(err.code).toBe('identity.stream_token_ttl_unset');
    expect(err.status).toBe(503);
  });

  it('cuts a token with the key’s own claims that ends at the owner lifetime', async () => {
    const principal = await keyPrincipal({ subAccountId: SUB });
    const before = Date.now();
    const out = await mintStreamToken({ principal, ttlSeconds: 20, tokens });
    expect(out.lifetimeSeconds).toBe(20);
    const life = Date.parse(out.expiresAt) - before;
    expect(life).toBeGreaterThan(18_000);
    expect(life).toBeLessThanOrEqual(21_000);
    // Minted for the stream audience: the platform audience (the edge's) refuses it.
    await expect(verifyAccessToken(out.token, tokens)).rejects.toThrow();
    const stream = await verifyAccessToken(out.token, { ...tokens, audience: streamTokenAudience(tokens.audience) });
    expect(stream.userId).toBe(principal.userId);
    expect(stream.kid).toBe(KEY);
    expect(stream.sid).toBe(principal.sid);
    expect(stream.sub_account).toBe(SUB);
    expect(stream.scopes).toEqual(principal.scopes);
    expect(stream.tier).toBe(principal.tier);
    expect(stream.key_env).toBe('live');
    // A second mint is a different token.
    expect((await mintStreamToken({ principal, ttlSeconds: 20, tokens })).token).not.toBe(out.token);
  });

  it('never outlives the principal it was cut from', async () => {
    const principal = await keyPrincipal({ ttl: 5 });
    const out = await mintStreamToken({ principal, ttlSeconds: 3600, tokens });
    expect(out.lifetimeSeconds).toBeLessThanOrEqual(5);
    expect(Date.parse(out.expiresAt)).toBeLessThanOrEqual(principal.expiresAt.getTime());
    const err = await refusal(mintStreamToken({ principal, ttlSeconds: 20, tokens, now: () => principal.expiresAt.getTime() }));
    expect(err.code).toBe('identity.stream_token_principal_expired');
  });

  it('refuses a session principal and no principal: a stream token is cut from a key only', async () => {
    expect((await refusal(mintStreamToken({ principal: await keyPrincipal({ apiKeyId: null }), ttlSeconds: 20, tokens }))).code).toBe(
      'identity.stream_token_key_only',
    );
    const anonymous = await refusal(mintStreamToken({ principal: null, ttlSeconds: 20, tokens }));
    expect(anonymous.code).toBe('identity.stream_token_unauthenticated');
    expect(anonymous.status).toBe(401);
  });
});
