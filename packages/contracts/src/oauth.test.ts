import { describe, expect, it } from 'vitest';
import {
  OAUTH_ERROR_CODES,
  OAUTH_VERIFIER_PATTERN,
  oauthAppRequestId,
  oauthAuthorizeRequestSchema,
  oauthErrorBody,
  oauthRedirectUrlProblem,
  oauthRegisterAppInputSchema,
  oauthTokenInputSchema,
} from './oauth.js';

const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('oauth redirect URLs', () => {
  it('accepts an exact HTTPS address', () => {
    expect(oauthRedirectUrlProblem('https://app.example.test/callback')).toBeNull();
    expect(oauthRedirectUrlProblem('https://app.example.test/callback?tenant=a')).toBeNull();
    expect(oauthRedirectUrlProblem('https://app.example.test:8443/callback')).toBeNull();
  });

  it('refuses http, wildcards, fragments, credentials, relative and empty values', () => {
    for (const bad of [
      'http://app.example.test/cb',
      'https://*.example.test/cb',
      'https://app.example.test/*',
      'https://app.example.test/cb#frag',
      'https://user:pass@app.example.test/cb',
      '/callback',
      'javascript:alert(1)',
      '',
      'https://\uff0a.example.test/cb',
      'HTTPS://app.example.test/cb',
      'https:\\\\app.example.test\\cb',
      'https:/app.example.test/cb',
      'https:app.example.test/cb',
      'https:///app.example.test/cb',
      ' https://app.example.test/cb',
      'https://app.example.test/cb ',
      'https://app.example.test/c\nb',
      'https://app.exa\tmple.test/cb',
      'https://app.example.test/cb\r\nX: y',
      'https://@app.example.test/cb',
      'https://:@app.example.test/cb',
      'https://%61pp.example.test/cb',
      'https://0x7f.1/cb',
      'https://App.Example.test/cb',
      'https://app.example.test:443/cb',
      'https://app.exämple.test/cb',
    ]) {
      expect(oauthRedirectUrlProblem(bad), bad).toBe('oauth.redirect_url_invalid');
    }
  });
});

describe('oauth registration input', () => {
  const base = {
    name: 'Ledger sync',
    redirectUrls: ['https://app.example.test/cb'],
    scopes: ['trade:read'],
    confidential: true,
    requestId: 'r1',
  };

  it('parses a valid app and refuses extra keys, empty scopes and an HTTP redirect', () => {
    expect(oauthRegisterAppInputSchema.safeParse(base).success).toBe(true);
    expect(oauthRegisterAppInputSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(oauthRegisterAppInputSchema.safeParse({ ...base, scopes: [] }).success).toBe(false);
    expect(oauthRegisterAppInputSchema.safeParse({ ...base, scopes: ['trade:read trade:write'] }).success).toBe(false);
    expect(oauthRegisterAppInputSchema.safeParse({ ...base, redirectUrls: ['http://app.example.test/cb'] }).success).toBe(false);
    expect(oauthRegisterAppInputSchema.safeParse({ ...base, redirectUrls: [] }).success).toBe(false);
  });

  it('keys a registration by developer and normalised name, never a random id', () => {
    expect(oauthAppRequestId('ABC', '  Ledger   Sync ')).toBe('oauth-app:abc:ledger sync');
    expect(oauthAppRequestId('abc', 'ledger sync')).toBe(oauthAppRequestId('ABC', 'Ledger Sync'));
  });
});

describe('oauth authorise and token shapes', () => {
  const request = {
    responseType: 'code',
    clientId: 'ifc_abc',
    redirectUri: 'https://app.example.test/cb',
    scope: ['trade:read'],
    state: 's1',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
  };

  it('requires state, a challenge and S256 only', () => {
    expect(oauthAuthorizeRequestSchema.safeParse(request).success).toBe(true);
    expect(oauthAuthorizeRequestSchema.safeParse({ ...request, state: '' }).success).toBe(false);
    const { state: _state, ...withoutState } = request;
    expect(oauthAuthorizeRequestSchema.safeParse(withoutState).success).toBe(false);
    expect(oauthAuthorizeRequestSchema.safeParse({ ...request, codeChallengeMethod: 'plain' }).success).toBe(false);
    expect(oauthAuthorizeRequestSchema.safeParse({ ...request, codeChallenge: 'short' }).success).toBe(false);
  });

  it('checks a verifier for length 43 to 128 and its character set', () => {
    expect(OAUTH_VERIFIER_PATTERN.test('a'.repeat(43))).toBe(true);
    expect(OAUTH_VERIFIER_PATTERN.test('a'.repeat(128))).toBe(true);
    expect(OAUTH_VERIFIER_PATTERN.test('a'.repeat(42))).toBe(false);
    expect(OAUTH_VERIFIER_PATTERN.test('a'.repeat(129))).toBe(false);
    expect(OAUTH_VERIFIER_PATTERN.test(`${'a'.repeat(42)}!`)).toBe(false);
    expect(OAUTH_VERIFIER_PATTERN.test(`${'a'.repeat(42)} `)).toBe(false);
    expect(OAUTH_VERIFIER_PATTERN.test(`${'a'.repeat(43)}\n`)).toBe(false);
  });

  it('accepts only the authorization_code grant', () => {
    const token = {
      grantType: 'authorization_code',
      code: 'c',
      redirectUri: 'https://app.example.test/cb',
      clientId: 'x',
      codeVerifier: 'v',
    };
    expect(oauthTokenInputSchema.safeParse(token).success).toBe(true);
    expect(oauthTokenInputSchema.safeParse({ ...token, grantType: 'password' }).success).toBe(false);
  });
});

describe('oauth error bodies', () => {
  it('gives every code a standard error and a description that holds no secret', () => {
    for (const code of OAUTH_ERROR_CODES) {
      const body = oauthErrorBody(code);
      expect(body, code).toBeDefined();
      expect(body?.error).toMatch(/^[a-z_]+$/);
      expect(body?.error_description.length).toBeGreaterThan(5);
    }
    expect(oauthErrorBody('oauth.unknown')).toBeUndefined();
    expect(oauthErrorBody('constructor')).toBeUndefined();
  });
});
