import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { verifyForwardedPrincipal, EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER } from '@intafaced/contracts';
import { exchangePrincipal, looksLikeApiKey, requestOrigin, stripReserved } from './principal-exchange.js';
import { currentAuthorityTestReply } from './test-current-authority.js';

const tokens: TokenConfig = {
  secret: 'edge-test-jwt-signing-secret-32-chars',
  issuer: 'intafaced',
  audience: 'intafaced',
  accessTtlSeconds: 900,
};

const EDGE_SECRET = 'edge-test-principal-secret-32-chars!';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

const AUTHORITY_SECRET = 'edge-test-identity-authority-secret-32';
const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: AUTHORITY_SECRET,
  fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION }) ?? new Response(null, { status: 404 }),
};

async function bearer(overrides: Partial<Parameters<typeof issueAccessToken>[0]> = {}) {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: ['trade:read', 'trade:write'], tier: 'basic', mfa: false, ...overrides },
    tokens,
  );
  return { authorization: `Bearer ${token}` };
}

describe('the exchange — a bearer token becomes a signed principal', () => {
  it('produces a principal the services will actually accept', async () => {
    const result = await exchangePrincipal(await bearer(), options);

    expect(result.principal?.userId).toBe(USER);
    expect(result.rejected).toBeNull();

    // The real assertion: verify with the SAME function every mounted service
    // uses. A header this test invents but `createEdgeContext` rejects would be
    // worse than no edge at all.
    const verified = verifyForwardedPrincipal(
      result.headers[EDGE_PRINCIPAL_HEADER],
      result.headers[EDGE_SIGNATURE_HEADER],
      EDGE_SECRET,
      new Date(),
      'GB',
    );
    expect(verified.rejected).toBeNull();
    expect(verified.principal?.userId).toBe(USER);
    expect(verified.principal?.scopes).toEqual(['trade:read', 'trade:write']);
    // Current identity ownership reports tier `none`; a stale JWT `basic` claim is lowered.
    expect(verified.principal?.tier).toBe('none');
  });

  it('carries mfa through, because INTERACTIVE_ONLY_SCOPES depends on it', async () => {
    const result = await exchangePrincipal(await bearer({ mfa: true, scopes: ['trade:withdraw'] }), options);
    const verified = verifyForwardedPrincipal(
      result.headers[EDGE_PRINCIPAL_HEADER],
      result.headers[EDGE_SIGNATURE_HEADER],
      EDGE_SECRET,
      new Date(),
      'GB',
    );

    expect(verified.principal?.mfa).toBe(true);
  });

  it('L2-4: forging region without re-signing fails verification', async () => {
    const result = await exchangePrincipal(await bearer(), options);
    const verified = verifyForwardedPrincipal(
      result.headers[EDGE_PRINCIPAL_HEADER],
      result.headers[EDGE_SIGNATURE_HEADER],
      EDGE_SECRET,
      new Date(),
      'US',
    );
    expect(verified.principal).toBeNull();
    expect(verified.rejected).toBe('bad-signature');
  });
});

describe('reserved headers are stripped, not overwritten', () => {
  /**
   * The attack this exists to stop. A client sends its own principal header
   * with `admin:treasury` and `mfa: true`. If the edge merely overwrote on
   * success, an ANONYMOUS request would sail through with the client's own.
   */
  it('drops a client-supplied principal on an anonymous request', async () => {
    const forged = JSON.stringify({
      sub: USER,
      userId: USER,
      sid: SESSION,
      scopes: ['admin:treasury', 'trade:withdraw'],
      tier: 'institutional',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await exchangePrincipal({ [EDGE_PRINCIPAL_HEADER]: forged, [EDGE_SIGNATURE_HEADER]: 'f'.repeat(64) }, options);

    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
    expect(result.headers[EDGE_SIGNATURE_HEADER]).toBeUndefined();
  });

  it('drops a client-supplied principal even when a valid token is also present', async () => {
    const forged = JSON.stringify({ userId: 'someone-else', scopes: ['admin:treasury'] });
    const result = await exchangePrincipal({ ...(await bearer()), [EDGE_PRINCIPAL_HEADER]: forged }, options);

    const verified = verifyForwardedPrincipal(
      result.headers[EDGE_PRINCIPAL_HEADER],
      result.headers[EDGE_SIGNATURE_HEADER],
      EDGE_SECRET,
      new Date(),
      'GB',
    );
    expect(verified.principal?.userId).toBe(USER);
    expect(verified.principal?.scopes).not.toContain('admin:treasury');
  });

  /**
   * Region drives the jurisdiction matrix — which modules a caller may reach.
   * A client that sets its own region selects its own regulator.
   */
  it('refuses a client-supplied region and substitutes the resolved one', async () => {
    const result = await exchangePrincipal({ ...(await bearer()), 'x-intafaced-region': 'XX' }, options);
    expect(result.headers['x-intafaced-region']).toBe('GB');
  });

  it('drops a client-supplied SERVICE credential', async () => {
    // Service identity is for service-to-service calls (#50). A browser must
    // never be able to claim it and reach `ledger.post`.
    const result = await exchangePrincipal(
      { ...(await bearer()), 'x-intafaced-service': 'svc-trade', 'x-intafaced-service-sig': 'a'.repeat(64) },
      options,
    );

    expect(result.headers['x-intafaced-service']).toBeUndefined();
    expect(result.headers['x-intafaced-service-sig']).toBeUndefined();
  });

  it('strips every reserved header regardless of case', () => {
    const out = stripReserved({
      'X-Intafaced-Principal': 'forged',
      'X-INTAFACED-REGION': 'XX',
      'x-intafaced-anything-future': 'v',
      'content-type': 'application/json',
    });

    expect(Object.keys(out)).toEqual(['content-type']);
  });

  it('never forwards the bearer token upstream', async () => {
    // A service that can read a token is a service that can replay it.
    const result = await exchangePrincipal(await bearer(), options);
    expect(result.headers.authorization).toBeUndefined();
  });

  it('does not proxy hop-by-hop headers or the client host', () => {
    const out = stripReserved({ host: 'evil.test', connection: 'keep-alive', 'content-length': '10', accept: '*/*' });
    expect(Object.keys(out)).toEqual(['accept']);
  });

  it('strips a client-supplied x-forwarded-origin (identity domain_whitelist)', () => {
    const out = stripReserved({
      origin: 'https://evil.example',
      'x-forwarded-origin': 'https://app.example.com',
      accept: '*/*',
    });
    expect(out['x-forwarded-origin']).toBeUndefined();
    expect(out.origin).toBe('https://evil.example');
  });

  /**
   * Audit 2026-08-08 #7: the filter claimed the hop-by-hop class and only
   * stripped `connection`. The full RFC 7230 set (plus host/content-length)
   * must die here so undici is not the last line of defence.
   */
  it('strips the full hop-by-hop class, not only connection', () => {
    const out = stripReserved({
      accept: 'application/json',
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      trailer: 'Expires',
      upgrade: 'websocket',
      'keep-alive': 'timeout=5',
      'proxy-authorization': 'Basic Zm9vOmJhcg==',
      'proxy-authenticate': 'Basic realm="x"',
      connection: 'close',
      host: 'evil.test',
      'content-length': '999',
      'x-forwarded-origin': 'https://forged.example',
    });
    expect(out).toEqual({ accept: 'application/json', 'content-type': 'application/json' });
    for (const name of [
      'transfer-encoding',
      'te',
      'trailer',
      'upgrade',
      'keep-alive',
      'proxy-authorization',
      'proxy-authenticate',
      'connection',
      'host',
      'content-length',
      'x-forwarded-origin',
    ]) {
      expect(out[name], name).toBeUndefined();
    }
  });
});

describe('bad credentials land as anonymous, never as an error', () => {
  it('treats a garbage token as anonymous rather than throwing', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer not-a-jwt' }, options);

    // `invalid`, not `malformed`: in packages/auth, `token.malformed` means the
    // signature verified but the payload shape did not. A string that fails
    // verification outright is `token.invalid`. The distinction is worth
    // keeping — one means "not from us", the other means "from us and wrong".
    expect(result.rejected).toBe('invalid');

    // These two are what actually matter, whichever code came back.
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('refuses a token signed with the wrong secret', async () => {
    const { token } = await issueAccessToken(
      { userId: USER, sessionId: SESSION, scopes: [], tier: 'basic', mfa: false },
      { ...tokens, secret: 'a-completely-different-signing-secret' },
    );

    const result = await exchangePrincipal({ authorization: `Bearer ${token}` }, options);
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('refuses an expired principal at the edge, not only at the service', async () => {
    const result = await exchangePrincipal(await bearer(), options, new Date(Date.now() + 3_600_000));

    expect(result.rejected).toBe('expired');
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('ignores a non-Bearer authorization scheme', async () => {
    const result = await exchangePrincipal({ authorization: 'Basic dXNlcjpwYXNz' }, options);
    expect(result.principal).toBeNull();
    expect(result.rejected).toBeNull();
  });

  it('passes an anonymous request through so public procedures still work', async () => {
    // register and login are publicProcedure. If the edge rejected anonymous
    // requests, nobody could ever obtain a token in the first place.
    const result = await exchangePrincipal({ 'content-type': 'application/json' }, options);

    expect(result.principal).toBeNull();
    expect(result.rejected).toBeNull();
    expect(result.headers['content-type']).toBe('application/json');
  });
});

describe('API key bearers (ifc_…) exchange into access JWTs', () => {
  it('detects platform keys vs JWTs', () => {
    expect(looksLikeApiKey('ifc_abc123')).toBe(true);
    expect(looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe(false);
    expect(looksLikeApiKey('not-a-key')).toBe(false);
  });

  it('calls identity exchange and signs a principal from the returned JWT', async () => {
    const { token: accessToken } = await issueAccessToken(
      { userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false },
      tokens,
    );

    const fetchMock: typeof fetch = async (input, init) => {
      const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
      if (authority) return authority;
      expect(String(input)).toContain('/trpc/apiKeys.exchange');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ json: { key: 'ifc_live_secret_key' } });
      return new Response(JSON.stringify({ result: { data: { json: { accessToken } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_live_secret_key' },
      { ...options, identityUrl: 'http://identity.test', fetch: fetchMock },
    );

    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
    expect(result.principal?.scopes).toEqual(['trade:read']);
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
    expect(result.headers.authorization).toBeUndefined();
  });

  it('lands as anonymous when identity refuses the key', async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 });

    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_wrong' },
      { ...options, identityUrl: 'http://identity.test', fetch: fetchMock },
    );

    expect(result.principal).toBeNull();
    expect(result.rejected).toBe('invalid');
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('forwards the real Origin to identity so domain_whitelist can fail closed', async () => {
    const { token: accessToken } = await issueAccessToken(
      { userId: USER, sessionId: SESSION, scopes: ['pay:write'], tier: 'basic', mfa: false },
      tokens,
    );

    const seen: string[] = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (String(_input).endsWith('/trpc/accountControls.currentAuthority')) {
        return currentAuthorityTestReply(_input, init, { expectedUserId: USER, expectedCredentialId: SESSION })!;
      }
      seen.push(headers.get('origin') ?? '');
      return new Response(JSON.stringify({ result: { data: { json: { accessToken } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await exchangePrincipal(
      { authorization: 'Bearer ifc_browser_key', origin: 'https://app.example.com' },
      { ...options, identityUrl: 'http://identity.test', fetch: fetchMock },
    );

    expect(seen).toEqual(['https://app.example.com']);
  });

  it('does not let a client x-forwarded-origin stand in for Origin', async () => {
    expect(requestOrigin({ 'x-forwarded-origin': 'https://app.example.com' })).toBeNull();

    const seen: Array<string | null> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get('origin'));
      return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 });
    };

    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_stolen', 'x-forwarded-origin': 'https://app.example.com' },
      { ...options, identityUrl: 'http://identity.test', fetch: fetchMock },
    );

    expect(seen).toEqual([null]);
    expect(result.headers['x-forwarded-origin']).toBeUndefined();
    expect(result.rejected).toBe('invalid');
  });

  it('rewrites x-forwarded-origin from the real Origin on the proxied path', async () => {
    const result = await exchangePrincipal(
      {
        ...(await bearer()),
        origin: 'https://app.example.com',
        'x-forwarded-origin': 'https://evil.example',
      },
      options,
    );
    expect(result.headers.origin).toBe('https://app.example.com');
    expect(result.headers['x-forwarded-origin']).toBe('https://app.example.com');
  });
});
