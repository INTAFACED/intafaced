import { describe, expect, it } from 'vitest';
import { firstBadRedirect, followableRedirect, parseAuthorizeSearch, parseRedirectInput, parseScopeInput } from './oauth-model';
import { scopeCopyKey, refusalCopyKey } from './apps-copy';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const query = (over: Record<string, string | null> = {}) => {
  const params: Record<string, string | null> = {
    response_type: 'code',
    client_id: 'ifc_abc',
    redirect_uri: 'https://app.example.test/cb',
    scope: 'trade:read identity:read',
    state: 's1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...over,
  };
  return '?' + new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== null)).toString();
};

describe('authorise request', () => {
  it('reads a complete request', () => {
    const parsed = parseAuthorizeSearch(query());
    expect(parsed).toEqual({
      ok: true,
      request: {
        responseType: 'code',
        clientId: 'ifc_abc',
        redirectUri: 'https://app.example.test/cb',
        scope: ['trade:read', 'identity:read'],
        state: 's1',
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      },
    });
  });

  it('names the first thing missing, and refuses plain, no state and no challenge', () => {
    const problem = (over: Record<string, string | null>) => {
      const parsed = parseAuthorizeSearch(query(over));
      return parsed.ok ? 'ok' : parsed.problem;
    };
    expect(problem({ state: null })).toBe('missing_state');
    expect(problem({ state: '' })).toBe('missing_state');
    expect(problem({ code_challenge: null })).toBe('missing_challenge');
    expect(problem({ code_challenge_method: 'plain' })).toBe('method_not_s256');
    expect(problem({ code_challenge_method: null })).toBe('method_not_s256');
    expect(problem({ response_type: 'token' })).toBe('response_type_not_code');
    expect(problem({ client_id: null })).toBe('missing_client_id');
    expect(problem({ redirect_uri: null })).toBe('missing_redirect_uri');
    expect(problem({ scope: '' })).toBe('missing_scope');
    expect(problem({ code_challenge: 'short' })).toBe('malformed');
    expect(problem({ scope: 'trade read' })).toBe('malformed');
  });
});

describe('form lists', () => {
  it('splits scopes on spaces, commas and lines, and drops repeats', () => {
    expect(parseScopeInput('trade:read, identity:read\ntrade:read')).toEqual(['trade:read', 'identity:read']);
    expect(parseScopeInput('  ')).toEqual([]);
    expect(parseRedirectInput('https://a.example.test/cb\nhttps://a.example.test/cb\n')).toEqual(['https://a.example.test/cb']);
  });

  it('finds the first redirect address that is not an exact https address', () => {
    expect(firstBadRedirect(['https://a.example.test/cb', 'http://b.example.test/cb', 'https://*.c.test/'])).toBe(
      'http://b.example.test/cb',
    );
    expect(firstBadRedirect(['https://a.example.test/cb'])).toBeNull();
  });
});

describe('the one redirect the page follows', () => {
  it('follows https only, with no credentials', () => {
    expect(followableRedirect('https://app.example.test/cb?code=x&state=y')).toBe('https://app.example.test/cb?code=x&state=y');
    expect(followableRedirect('http://app.example.test/cb')).toBeNull();
    expect(followableRedirect('javascript:alert(1)')).toBeNull();
    expect(followableRedirect('https://u:p@app.example.test/cb')).toBeNull();
    expect(followableRedirect('not a url')).toBeNull();
  });
});

describe('copy lookups', () => {
  it('has plain words for the scopes it knows and none for others', () => {
    expect(scopeCopyKey('trade:read')).toBe('scope_trade_read');
    expect(scopeCopyKey('academy:read')).toBeNull();
    expect(refusalCopyKey('oauth.scope_not_delegable')).toBe('oauth.scope_not_delegable');
    expect(refusalCopyKey('oauth.unknown')).toBeNull();
    expect(refusalCopyKey('constructor')).toBeNull();
    expect(refusalCopyKey(undefined)).toBeNull();
  });
});
