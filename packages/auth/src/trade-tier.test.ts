import { describe, expect, it } from 'vitest';
import { AuthError, requireTier, requireTradeTier, tradeTier, type Principal } from './index.js';
import { issueAccessToken, verifyAccessToken } from './tokens.js';

// The trading checks' clear (OWNER 258 (4)) opens trading alone: `trd` counts as basic only where a trading gate reads
// `tradeTier`; every other gate reads `tier`, which stays the level an operator approved.

const config = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const USER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

const p = (over: Partial<Principal>) => ({ tier: 'none', ...over }) as Principal;

describe('tradeTier', () => {
  it('reads the trading clear as basic for a person with no approved level, and nothing else', () => {
    expect(tradeTier(p({ tier: 'none', trd: true }))).toBe('basic');
    expect(tradeTier(p({ tier: 'none' }))).toBe('none');
    expect(tradeTier(p({ tier: 'none', trd: false }))).toBe('none');
    expect(tradeTier(p({ tier: 'full', trd: true }))).toBe('full');
  });

  it('a trading gate opens on the clear; a gate that reads the level does not', () => {
    const cleared = p({ tier: 'none', trd: true });
    expect(() => requireTradeTier(cleared, 'basic')).not.toThrow();
    expect(() => requireTradeTier(cleared, 'full')).toThrow(AuthError);
    expect(() => requireTier(cleared, 'basic')).toThrow(AuthError);
    expect(() => requireTradeTier(p({ tier: 'none' }), 'basic')).toThrow(AuthError);
  });

  it('a token carries trd only when the trading checks cleared the person, and it survives verification', async () => {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: [], tier: 'none', tradingCleared: true }, config);
    const got = await verifyAccessToken(token, config);
    expect(got.tier).toBe('none');
    expect(got.trd).toBe(true);
    const plain = await verifyAccessToken((await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: [] }, config)).token, config);
    expect(plain.trd).toBeUndefined();
  });
});
