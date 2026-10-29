import { describe, expect, it } from 'vitest';
import type { Principal } from './tokens.js';
import { issueAccessToken, verifyAccessToken, AuthError, generateRefreshToken, hashRefreshToken } from './tokens.js';
import { requireScope, requireTier, requireOwnership, requireMfa, bearerToken } from './guards.js';
import {
  assertDelegatableScopes,
  assertKeyScopesAllowed,
  PERSON_ONLY_SCOPES,
  isKeyForbiddenScope,
  expandScopes,
  hasScope,
  isScope,
  INTERACTIVE_ONLY_SCOPES,
  SCOPES,
  SESSION_SCOPES,
  WITHHELD_FROM_SESSION,
} from './scopes.js';

const config = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

async function principal(overrides: Partial<Parameters<typeof issueAccessToken>[0]> = {}) {
  const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:write'], ...overrides }, config);
  return verifyAccessToken(token, config);
}

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const p = await principal({ scopes: ['trade:write', 'pay:read'], tier: 'full', mfa: true });
    expect(p.userId).toBe(USER);
    expect(p.sid).toBe(SESSION);
    expect(p.tier).toBe('full');
    expect(p.mfa).toBe(true);
    expect(p.scopes).toContain('trade:write');
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: [] }, config);
    await expect(verifyAccessToken(token, { ...config, secret: 'a-completely-different-secret-value!!' })).rejects.toThrow(AuthError);
  });

  it('rejects a token issued for another audience', async () => {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: [] }, config);
    await expect(verifyAccessToken(token, { ...config, audience: 'someone.else' })).rejects.toMatchObject({
      code: 'token.invalid',
    });
  });

  it('rejects an expired token', async () => {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: [] }, { ...config, accessTtlSeconds: -1 });
    await expect(verifyAccessToken(token, config)).rejects.toMatchObject({ code: 'token.expired' });
  });

  it('rejects a tampered token', async () => {
    const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'] }, config);
    const [header, , signature] = token.split('.');
    const forged = `${header}.${Buffer.from(JSON.stringify({ sub: USER, scopes: ['admin:treasury'] })).toString('base64url')}.${signature}`;
    await expect(verifyAccessToken(forged, config)).rejects.toThrow(AuthError);
  });

  it('refuses a weak signing secret outright', async () => {
    await expect(issueAccessToken({ userId: USER, sessionId: SESSION, scopes: [] }, { ...config, secret: 'tooshort' })).rejects.toThrow(
      AuthError,
    );
  });
});

describe('refresh tokens', () => {
  it('never stores the usable value', () => {
    const { token, hash } = generateRefreshToken();
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
    expect(hashRefreshToken(token)).toBe(hash);
  });

  it('generates a distinct token every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateRefreshToken().token));
    expect(tokens.size).toBe(100);
  });
});

describe('scopes', () => {
  it('recognises only declared scopes', () => {
    expect(isScope('trade:write')).toBe(true);
    expect(isScope('trade:everything')).toBe(false);
  });

  it('has no ledger:write scope — balances never move on a user token', () => {
    expect(SCOPES).not.toContain('ledger:write');
  });

  it('never lets :write grant :read or :read grant :write', () => {
    for (const scope of SCOPES) {
      expect(hasScope([scope], scope), `${scope} stays granted`).toBe(true);
      const [module, action] = scope.split(':');
      if (action === 'write') {
        const read = `${module}:read`;
        if (isScope(read)) expect(hasScope([scope], read)).toBe(false);
      }
      if (action === 'read') {
        const write = `${module}:write`;
        if (isScope(write)) expect(hasScope([scope], write)).toBe(false);
      }
    }
    expect(hasScope(['admin:write'], 'admin:read')).toBe(false);
    expect(hasScope(['pay:refund'], 'pay:read')).toBe(false);
    expect(hasScope(['pay:payout'], 'pay:read')).toBe(false);
    expect(hasScope(['token:stake'], 'token:read')).toBe(false);
    expect(expandScopes(['trade:write', 'ledger:read'])).toEqual(new Set(['trade:write', 'ledger:read']));
    expect(expandScopes(['pay:refund'])).toEqual(new Set(['pay:refund']));
    expect(expandScopes(['pay:payout'])).toEqual(new Set(['pay:payout']));
    expect(expandScopes(['token:stake'])).toEqual(new Set(['token:stake']));
  });

  it('does not let bank:card, market:ops, agents:execute, or support:ops grant an unlisted :read', () => {
    expect(expandScopes(['bank:card'])).toEqual(new Set(['bank:card']));
    expect(hasScope(['bank:card'], 'bank:read')).toBe(false);
    expect(expandScopes(['market:ops'])).toEqual(new Set(['market:ops']));
    expect(hasScope(['market:ops'], 'market:read')).toBe(false);
    expect(expandScopes(['agents:execute'])).toEqual(new Set(['agents:execute']));
    expect(hasScope(['agents:execute'], 'agents:read')).toBe(false);
    expect(expandScopes(['support:ops'])).toEqual(new Set(['support:ops']));
    expect(hasScope(['support:ops'], 'support:read')).toBe(false);

    expect(expandScopes(['bank:card', 'bank:read'])).toEqual(new Set(['bank:card', 'bank:read']));
    expect(hasScope(['bank:card', 'bank:read'], 'bank:read')).toBe(true);
    expect(expandScopes(['market:ops', 'market:read'])).toEqual(new Set(['market:ops', 'market:read']));
    expect(hasScope(['market:ops', 'market:read'], 'market:read')).toBe(true);
    expect(expandScopes(['agents:execute', 'agents:read'])).toEqual(new Set(['agents:execute', 'agents:read']));
    expect(hasScope(['agents:execute', 'agents:read'], 'agents:read')).toBe(true);
    expect(expandScopes(['support:ops', 'support:read'])).toEqual(new Set(['support:ops', 'support:read']));
    expect(hasScope(['support:ops', 'support:read'], 'support:read')).toBe(true);

    expect(expandScopes(['admin:treasury'])).toEqual(new Set(['admin:treasury', 'admin:read']));
    expect(expandScopes(['admin:compliance'])).toEqual(new Set(['admin:compliance', 'admin:read']));
    expect(hasScope(['trade:write'], 'pay:write')).toBe(false);
  });

  it('ignores unknown scopes rather than trusting them', () => {
    expect(expandScopes(['not:a:scope', 'trade:read'])).toEqual(new Set(['trade:read']));
  });

  it('refuses to mint an API key that can withdraw', () => {
    expect(() => assertKeyScopesAllowed(['trade:read', 'trade:withdraw'])).toThrow(/interactive/);
    expect(() => assertKeyScopesAllowed(['trade:read', 'trade:write'])).not.toThrow();
  });
});

describe('what a session is issued', () => {
  it('accounts for every scope exactly once — issued, or withheld with a reason', () => {
    // The compiler already enforces this through
    // `Record<Exclude<Scope, SessionScope>, string>`; the test states it in
    // terms a reader can check. A scope in neither list is a screen nobody can
    // open (bank and blueprint, until this change) or authority nobody decided
    // to hand out.
    const issued = new Set<string>(SESSION_SCOPES);
    const withheld = new Set(Object.keys(WITHHELD_FROM_SESSION));

    for (const scope of SCOPES) {
      expect(issued.has(scope) !== withheld.has(scope), `${scope} must be issued or withheld, not both or neither`).toBe(true);
    }
    expect(issued.size + withheld.size).toBe(SCOPES.length);
    for (const reason of Object.values(WITHHELD_FROM_SESSION)) expect(reason.length).toBeGreaterThan(0);
  });

  it('opens bank and blueprint — the two modules that were issued to nobody', () => {
    // The regression this change exists to prevent. Both services require these
    // on every procedure; neither was ever issued, so both answered 403 to the
    // entire platform.
    for (const scope of ['bank:read', 'bank:write', 'blueprint:read', 'blueprint:write']) {
      expect(SESSION_SCOPES, `${scope} is required by a live router`).toContain(scope);
    }
  });

  it('withholds every scope that moves value off the platform or runs the platform', () => {
    for (const scope of INTERACTIVE_ONLY_SCOPES) {
      expect(SESSION_SCOPES, `${scope} is interactive-only and must never be a default`).not.toContain(scope);
    }
    for (const scope of SCOPES.filter((s) => s.startsWith('admin:'))) {
      expect(SESSION_SCOPES, `${scope} is operator authority`).not.toContain(scope);
    }
    // The escalation that matters most: approving your own KYC record clears
    // the tier gate on every custodial module in the OS.
    expect(SESSION_SCOPES).not.toContain('admin:compliance');
  });

  it('issues no scope that implies one it withholds', () => {
    // A listed implication still expands. Issuing a scope whose implication is
    // withheld would grant by the back door what the table says is withheld.
    const granted = expandScopes([...SESSION_SCOPES]);
    for (const scope of granted) {
      expect(WITHHELD_FROM_SESSION, `${scope} is reachable by implication but listed as withheld`).not.toHaveProperty(scope);
    }
  });
});

describe('delegation — an API key cannot exceed the session that minted it', () => {
  it('refuses the self-verification escalation', () => {
    // The hole: `apiKeys.create` took a scope array from the request body and
    // stored it verbatim. Any logged-in account could mint a key holding
    // `admin:compliance`, approve its own KYC record to `institutional`, and
    // clear the tier gate on every custodial module in the platform.
    expect(() => assertDelegatableScopes(['admin:compliance'], [...SESSION_SCOPES])).toThrow(/cannot be granted to an API key/);
    expect(() => assertDelegatableScopes(['admin:write'], [...SESSION_SCOPES])).toThrow(/cannot be granted to an API key/);
  });

  it('allows a key to carry what its session actually holds', () => {
    expect(() => assertDelegatableScopes(['trade:read', 'bank:read'], [...SESSION_SCOPES])).not.toThrow();
  });

  it('does not treat :write as permission to delegate the matching :read', () => {
    expect(() => assertDelegatableScopes(['bank:read'], ['bank:write'])).toThrow(/does not hold/);
    expect(() => assertDelegatableScopes(['bank:write'], ['bank:read'])).toThrow(/does not hold/);
    expect(() => assertDelegatableScopes(['bank:write'], ['bank:write'])).not.toThrow();
    expect(() => assertDelegatableScopes(['bank:read'], ['bank:card'])).toThrow(/does not hold/);
    expect(() => assertDelegatableScopes(['bank:read'], ['bank:card', 'bank:read'])).not.toThrow();
  });

  it('still refuses interactive-only scopes, even from a session that holds them', () => {
    // A step-up session genuinely holds `trade:withdraw`. A long-lived key must
    // still never carry it (§9).
    expect(() => assertDelegatableScopes(['trade:withdraw'], ['trade:withdraw'])).toThrow(/interactive/);
    expect(() => assertDelegatableScopes(['pay:onboard'], ['pay:onboard'])).toThrow(/interactive/);
    expect(() => assertKeyScopesAllowed(['pay:onboard'])).toThrow(/API key/);
  });

  it('delegates pay:refund and pay:payout only when the call says step-up and the token holds them', () => {
    expect(() => assertDelegatableScopes(['pay:refund'], ['pay:refund', ...SESSION_SCOPES])).toThrow(/step-up/);
    expect(() => assertDelegatableScopes(['pay:payout'], ['pay:payout'])).toThrow(/step-up/);
    expect(() => assertKeyScopesAllowed(['pay:refund', 'pay:payout'])).not.toThrow();
    expect(() => assertDelegatableScopes(['pay:refund'], ['pay:refund'], { payStepUp: true })).not.toThrow();
    expect(() => assertDelegatableScopes(['pay:payout', 'pay:read'], ['pay:payout'], { payStepUp: true })).toThrow(/does not hold/);
    expect(() => assertDelegatableScopes(['pay:refund'], [...SESSION_SCOPES], { payStepUp: true })).toThrow(/does not hold/);
  });

  it('refuses unknown scope strings instead of storing them', () => {
    // Stored silently, these leave an audit trail claiming a key holds
    // authority that no guard will ever recognise.
    expect(() => assertDelegatableScopes(['bank:admin'], [...SESSION_SCOPES])).toThrow(/Unknown scopes/);
  });
});

describe('guards', () => {
  it('allows a call the principal is scoped for', async () => {
    const p = await principal({ scopes: ['trade:write'] });
    expect(() => requireScope(p, 'trade:write')).not.toThrow();
    expect(() => requireScope(p, 'trade:read')).toThrow(AuthError);
  });

  it('denies a call the principal is not scoped for', async () => {
    const p = await principal({ scopes: ['trade:read'] });
    expect(() => requireScope(p, 'pay:write')).toThrow(AuthError);
  });

  it('demands 2FA for withdrawal even when the scope is present', async () => {
    const withoutMfa = await principal({ scopes: ['trade:withdraw'], mfa: false });
    expect(() => requireScope(withoutMfa, 'trade:withdraw')).toThrow(/two-factor/);

    const withMfa = await principal({ scopes: ['trade:withdraw'], mfa: true });
    expect(() => requireScope(withMfa, 'trade:withdraw')).not.toThrow();
  });

  it('enforces verification tiers', async () => {
    const p = await principal({ tier: 'basic' });
    expect(() => requireTier(p, 'basic')).not.toThrow();
    expect(() => requireTier(p, 'full')).toThrow(AuthError);
  });

  it('refuses to act on another account', async () => {
    const p = await principal();
    expect(() => requireOwnership(p, USER)).not.toThrow();
    expect(() => requireOwnership(p, '55555555-5555-4555-8555-555555555555')).toThrow(AuthError);
  });

  it('gives each refusal its OWN code — all three used to be scope.denied', async () => {
    // Same class, same HTTP status, three different things to tell a user:
    //   scope.denied       nothing you do to your account changes this
    //   tier.insufficient  verify, and come back — an action they can take
    //   ownership.denied   this is someone else's; never offer a way forward
    const p = await principal({ scopes: ['bank:read'], tier: 'none' });

    const codeOf = (fn: () => void) => {
      try {
        fn();
        return 'no-throw';
      } catch (err) {
        return err instanceof AuthError ? err.code : 'not-an-AuthError';
      }
    };

    expect(codeOf(() => requireScope(p, 'admin:compliance'))).toBe('scope.denied');
    expect(codeOf(() => requireTier(p, 'full'))).toBe('tier.insufficient');
    expect(codeOf(() => requireOwnership(p, '55555555-5555-4555-8555-555555555555'))).toBe('ownership.denied');
    expect(codeOf(() => requireMfa(p))).toBe('mfa.required');
  });

  it('names the tier to reach, so a client need not guess the next step', async () => {
    const p = await principal({ tier: 'none' });
    expect(() => requireTier(p, 'full')).toThrow(/full/);
  });

  it('requires MFA explicitly', async () => {
    const p = await principal({ mfa: false });
    expect(() => requireMfa(p)).toThrow(AuthError);
  });

  it('refuses a key-authenticated request carrying admin:write', async () => {
    const keyed = await principal({
      scopes: ['admin:write', 'trade:read'],
      mfa: true,
      apiKeyId: '55555555-5555-4555-8555-555555555555',
    });
    expect(keyed.kid).toBe('55555555-5555-4555-8555-555555555555');

    expect(() => requireScope(keyed, 'admin:write')).toThrow(AuthError);
    try {
      requireScope(keyed, 'admin:write');
    } catch (err) {
      expect(err).toMatchObject({ code: 'scope.interactive_only' });
    }
    // The same key still uses the scopes that are allowed on a long-lived key.
    expect(() => requireScope(keyed, 'trade:read')).not.toThrow();
  });

  it('refuses desk scopes on a key even when the token claims MFA', async () => {
    const keyId = '66666666-6666-4666-8666-666666666666';
    for (const scope of ['admin:read', 'admin:write', 'admin:compliance', 'admin:treasury', 'support:ops', 'market:ops'] as const) {
      const keyed = await principal({ scopes: [scope], mfa: true, apiKeyId: keyId });
      let thrown: unknown;
      try {
        requireScope(keyed, scope);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, scope).toMatchObject({ code: 'scope.interactive_only' });
    }
  });

  it('lets a founder session use desk scopes interactively', async () => {
    const session = await principal({
      scopes: ['admin:read', 'admin:write', 'admin:treasury', 'support:ops', 'market:ops', 'admin:compliance'],
      mfa: true,
    });
    expect(session.kid).toBeUndefined();
    expect(() => requireScope(session, 'admin:write')).not.toThrow();
    expect(() => requireScope(session, 'admin:read')).not.toThrow();
    expect(() => requireScope(session, 'support:ops')).not.toThrow();
    expect(() => requireScope(session, 'admin:treasury')).not.toThrow();
    expect(() => requireScope(session, 'market:ops')).not.toThrow();
    expect(() => requireScope(session, 'admin:compliance')).not.toThrow();
  });

  it('still lets a founder read the desk before MFA', async () => {
    const session = await principal({ scopes: ['admin:read', 'support:ops', 'admin:treasury'], mfa: false });
    expect(() => requireScope(session, 'admin:read')).not.toThrow();
    expect(() => requireScope(session, 'support:ops')).not.toThrow();
    let thrown: unknown;
    try {
      requireScope(session, 'admin:treasury');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'mfa.required' });
  });

  it('keeps pay:onboard off a key and still demands 2FA on a session', async () => {
    const session = await principal({ scopes: ['pay:onboard'], mfa: false });
    let withoutMfa: unknown;
    try {
      requireScope(session, 'pay:onboard');
    } catch (err) {
      withoutMfa = err;
    }
    expect(withoutMfa).toMatchObject({ code: 'mfa.required' });

    const stepped = await principal({ scopes: ['pay:onboard'], mfa: true });
    expect(() => requireScope(stepped, 'pay:onboard')).not.toThrow();

    const keyed = await principal({
      scopes: ['pay:onboard'],
      mfa: true,
      apiKeyId: '77777777-7777-4777-8777-777777777777',
    });
    let fromKey: unknown;
    try {
      requireScope(keyed, 'pay:onboard');
    } catch (err) {
      fromKey = err;
    }
    expect(fromKey).toMatchObject({ code: 'scope.interactive_only' });
  });
});

describe('bearerToken', () => {
  it('parses a header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
  });

  it('returns null for anything else', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
  });
});

/**
 * A token with no expiry is not a long-lived token. It is a token with no
 * expiry, and it must not verify.
 *
 * jose validates `exp` only when the claim is present. Without `requiredClaims`
 * a validly-signed token carrying none verified — and `expiresAt` was then
 * manufactured as `new Date((payload.exp ?? 0) * 1000)`, i.e. 1970, for a token
 * the function had just accepted.
 *
 * It mattered unevenly. Through the edge, `verifyForwardedPrincipal` re-checks
 * `expiresAt`, so 1970 failed closed. The two callers that use this function
 * DIRECTLY — svc-ledger's operator HTTP and svc-edge's admin API — do not, and
 * those are the freeze, reconcile, kill-switch and treasury doors.
 */
describe('an access token must carry an expiry', () => {
  /** Signed with the real secret and the real issuer/audience — only `exp` is missing. */
  async function tokenWithoutExp(): Promise<string> {
    const { SignJWT } = await import('jose');
    return new SignJWT({ sid: SESSION, scopes: ['trade:write'], tier: 'basic', mfa: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt()
      .setJti('00000000-0000-4000-8000-000000000000')
      .sign(new TextEncoder().encode(config.secret));
  }

  it('refuses a validly-signed token that carries no exp', async () => {
    await expect(verifyAccessToken(await tokenWithoutExp(), config)).rejects.toBeInstanceOf(AuthError);
  });

  it('refuses it as a claims problem, not as a forged signature', async () => {
    // The signature is genuine and every other claim is valid — this fixture
    // differs from a real token in exactly one way, the missing `exp`. Reported
    // as `token.invalid` so an operator reading the log does not go looking for
    // a leaked secret.
    const err = (await verifyAccessToken(await tokenWithoutExp(), config).catch((e: unknown) => e)) as AuthError;
    expect(err.code).toBe('token.invalid');
  });

  it('still accepts a normally issued token and reports a real expiry', async () => {
    const p = await principal();
    expect(p.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Never 1970 — the value the `?? 0` fallback used to produce.
    expect(p.expiresAt.getFullYear()).toBeGreaterThan(2000);
  });
});

/**
 * `token.malformed` — emitted in source, mapped downstream, produced by no test.
 *
 * It is the version-skew branch: a token that VERIFIES against our own secret
 * and then fails the claims schema. That is a different fact from a forged
 * token, which is why it has its own code — an operator seeing this one should
 * be looking at a deploy, not at a leaked secret. Worth executing, because a
 * refusal nothing produces is a refusal nobody has checked reaches the client
 * with the right meaning.
 */
describe('a validly-signed token with the wrong claims shape', () => {
  it('is malformed, not invalid', async () => {
    const { SignJWT } = await import('jose');
    // Everything a real token has, except `sid` — which became required after
    // tokens minted without it were already in circulation.
    const token = await new SignJWT({ scopes: ['trade:write'], tier: 'basic', mfa: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(config.secret));

    const err = (await verifyAccessToken(token, config).catch((e: unknown) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('token.malformed');
  });
});

describe('agents:execute never sits on an API key (OWNER 107, 29 Oct 2026)', () => {
  it('is refused on a key even from a session that holds it, and an API key cannot exercise it', () => {
    expect(PERSON_ONLY_SCOPES).toContain('agents:execute');
    expect(() => assertKeyScopesAllowed(['agents:execute'])).toThrow(/cannot be granted to an API key/);
    expect(() => assertDelegatableScopes(['agents:read', 'agents:execute'], ['agents:read', 'agents:execute'])).toThrow(
      /cannot be granted to an API key/,
    );
    expect(() => assertDelegatableScopes(['agents:read'], ['agents:read', 'agents:execute'])).not.toThrow();
    const key = {
      sub: 'u',
      userId: 'u',
      sid: 's',
      scopes: ['agents:execute'],
      tier: 'none',
      mfa: false,
      kid: 'k1',
    } as unknown as Principal;
    expect(() => requireScope(key, 'agents:execute')).toThrow(expect.objectContaining({ code: 'scope.interactive_only' }));
    const sub = { ...key, kid: undefined, sub_account: '77777777-7777-4777-8777-777777777777' } as unknown as Principal;
    expect(() => requireScope(sub, 'agents:execute')).toThrow(expect.objectContaining({ code: 'scope.interactive_only' }));
    expect(isKeyForbiddenScope('agents:execute')).toBe(true);
    expect(isKeyForbiddenScope('admin:write')).toBe(true);
    expect(isKeyForbiddenScope('agents:read')).toBe(false);
    const person = { ...key, kid: undefined } as unknown as Principal;
    expect(() => requireScope(person, 'agents:execute')).not.toThrow();
  });
});
