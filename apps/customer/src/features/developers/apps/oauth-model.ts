/**
 * Pure rules for the OAuth app screens: reading the authorise request from the address, reading the form's lists, and the
 * only redirect the page will follow. The server checks every one of these again; these refuse the same things before a
 * request is sent, and never invent a value the person did not enter.
 */
import { oauthAuthorizeRequestSchema, oauthRedirectUrlProblem, type OAuthAuthorizeRequest } from '@intafaced/contracts/oauth';

export type AuthorizeProblem =
  | 'missing_client_id'
  | 'missing_redirect_uri'
  | 'missing_state'
  | 'missing_challenge'
  | 'method_not_s256'
  | 'response_type_not_code'
  | 'missing_scope'
  | 'malformed';

export type AuthorizeParse = { ok: true; request: OAuthAuthorizeRequest } | { ok: false; problem: AuthorizeProblem };

/** Words and commas separate scopes; repeats collapse; order is kept. */
export function parseList(text: string, separator: RegExp): string[] {
  return [
    ...new Set(
      text
        .split(separator)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}
export const parseScopeInput = (text: string) => parseList(text, /[\s,]+/);
export const parseRedirectInput = (text: string) => parseList(text, /\s+/);

/** The first thing wrong with the request the third party sent, in the order a developer would fix it. */
export function parseAuthorizeSearch(search: string): AuthorizeParse {
  const params = new URLSearchParams(search);
  const get = (name: string) => params.get(name) ?? '';
  if (get('response_type') !== 'code') return { ok: false, problem: 'response_type_not_code' };
  if (!get('client_id')) return { ok: false, problem: 'missing_client_id' };
  if (!get('redirect_uri')) return { ok: false, problem: 'missing_redirect_uri' };
  if (!get('state')) return { ok: false, problem: 'missing_state' };
  if (!get('code_challenge')) return { ok: false, problem: 'missing_challenge' };
  if (get('code_challenge_method') !== 'S256') return { ok: false, problem: 'method_not_s256' };
  const scope = parseScopeInput(get('scope'));
  if (scope.length === 0) return { ok: false, problem: 'missing_scope' };
  const parsed = oauthAuthorizeRequestSchema.safeParse({
    responseType: 'code',
    clientId: get('client_id'),
    redirectUri: get('redirect_uri'),
    scope,
    state: get('state'),
    codeChallenge: get('code_challenge'),
    codeChallengeMethod: 'S256',
  });
  return parsed.success ? { ok: true, request: parsed.data } : { ok: false, problem: 'malformed' };
}

/** The address a registered redirect URL fails on, or null when every line is acceptable. */
export function firstBadRedirect(urls: readonly string[]): string | null {
  return urls.find((url) => oauthRedirectUrlProblem(url) !== null) ?? null;
}

/** The page only follows an HTTPS address the service handed back. */
export function followableRedirect(target: string): string | null {
  try {
    const url = new URL(target);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
