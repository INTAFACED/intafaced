/**
 * OAuth provider contract (DV-oauth-01): app registration, the authorisation request and the code exchange.
 *
 * Browser safe: nothing here imports Node. The server checks every rule again; these helpers let the registration form
 * and the consent page refuse the same things before a request is sent.
 *
 * Rules carried by the shapes below:
 * - PKCE is required for every client and only S256 is accepted. `state` is required.
 * - Redirect URLs are exact HTTPS strings: no wildcard, no fragment, no credentials.
 * - A client secret is returned once, at registration or at a roll, and never again.
 * - Lifetimes come from the owner. A blank one refuses with `oauth.lifetime_unset`, never a default.
 */
import { z } from 'zod';

export const OAUTH_APP_STATUSES = ['pending', 'approved', 'suspended'] as const;
export type OAuthAppStatus = (typeof OAUTH_APP_STATUSES)[number];

/** Codes a client can branch on. The standard `error` value of each is in `OAUTH_ERROR_BODY`. */
export const OAUTH_ERROR_CODES = [
  'oauth.invalid_request',
  'oauth.invalid_client',
  'oauth.invalid_grant',
  'oauth.invalid_scope',
  'oauth.access_denied',
  'oauth.redirect_uri_mismatch',
  'oauth.app_not_approved',
  'oauth.app_not_found',
  'oauth.redirect_url_invalid',
  'oauth.scope_not_delegable',
  'oauth.scope_empty',
  'oauth.lifetime_unset',
  'oauth.idempotency_conflict',
  'oauth.key_principal_refused',
  'oauth.account_not_active',
  'oauth.operator_denied',
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/** The `error` / `error_description` pair of an OAuth error reply. The descriptions never carry a secret, a code or a token. */
export const OAUTH_ERROR_BODY: Readonly<Record<OAuthErrorCode, { error: string; error_description: string }>> = {
  'oauth.invalid_request': {
    error: 'invalid_request',
    error_description: 'The request is missing a required value or has a malformed one.',
  },
  'oauth.invalid_client': { error: 'invalid_client', error_description: 'The client could not be authenticated.' },
  'oauth.invalid_grant': { error: 'invalid_grant', error_description: 'The code is invalid, expired, already used or does not match.' },
  'oauth.invalid_scope': { error: 'invalid_scope', error_description: 'A requested scope is not one this app declared.' },
  'oauth.access_denied': { error: 'access_denied', error_description: 'The person did not allow the request.' },
  'oauth.redirect_uri_mismatch': { error: 'invalid_request', error_description: 'The redirect URL is not one this app registered.' },
  'oauth.app_not_approved': { error: 'unauthorized_client', error_description: 'This app has not been approved for other accounts.' },
  'oauth.app_not_found': { error: 'invalid_client', error_description: 'No such app.' },
  'oauth.redirect_url_invalid': { error: 'invalid_request', error_description: 'A redirect URL must be an exact HTTPS address.' },
  'oauth.scope_not_delegable': {
    error: 'invalid_scope',
    error_description: 'A scope that needs an interactive session cannot be declared.',
  },
  'oauth.scope_empty': { error: 'invalid_scope', error_description: 'At least one scope is required.' },
  'oauth.lifetime_unset': { error: 'temporarily_unavailable', error_description: 'The owner has not published this lifetime.' },
  'oauth.idempotency_conflict': { error: 'invalid_request', error_description: 'This request id was already used for a different app.' },
  'oauth.key_principal_refused': { error: 'access_denied', error_description: 'An API key cannot manage apps; sign in.' },
  'oauth.account_not_active': { error: 'access_denied', error_description: 'This account cannot authorise apps right now.' },
  'oauth.operator_denied': { error: 'access_denied', error_description: 'An operator session is required.' },
};

export function oauthErrorBody(code: string): { error: string; error_description: string } | undefined {
  return Object.prototype.hasOwnProperty.call(OAUTH_ERROR_BODY, code) ? OAUTH_ERROR_BODY[code as OAuthErrorCode] : undefined;
}

export const OAUTH_REDIRECT_URL_MAX = 2000;
export const OAUTH_REDIRECT_URLS_MAX = 10;
export const OAUTH_STATE_MAX = 512;

/** RFC 7636: 43 to 128 characters from the unreserved set. */
export const OAUTH_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is the unpadded base64url of 32 bytes. */
export const OAUTH_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

/** No whitespace, backslash or control characters anywhere, and a lowercase `https://` start. */
const RAW_HTTPS_URL = /^https:\/\/[^\s\\\u0000-\u001f\u007f-\u009f]+$/;

/**
 * `null` when the URL is acceptable, else why it is not. The raw string is what gets stored and compared, so it must
 * already be the canonical form: the authority is plain lowercase ASCII, equal to what the URL parser makes of it.
 * That refuses a wildcard (also a full-width one), userinfo in any form, percent-encoded or numeric hosts,
 * a default port written out, and anything the parser would quietly tidy.
 */
export function oauthRedirectUrlProblem(value: string): 'oauth.redirect_url_invalid' | null {
  if (value.length === 0 || value.length > OAUTH_REDIRECT_URL_MAX || value.includes('*') || value.includes('#')) {
    return 'oauth.redirect_url_invalid';
  }
  if (!RAW_HTTPS_URL.test(value)) return 'oauth.redirect_url_invalid';
  const authority = value.slice('https://'.length).split(/[/?]/)[0] ?? '';
  if (!/^[a-z0-9.\-[\]:]+$/.test(authority)) return 'oauth.redirect_url_invalid';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'oauth.redirect_url_invalid';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.host !== authority) return 'oauth.redirect_url_invalid';
  return null;
}

/** One id per (developer, app name): a double click or a retry after a lost reply returns the first result. */
export function oauthAppRequestId(userId: string, name: string): string {
  return `oauth-app:${userId.toLowerCase()}:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

const redirectUrl = z
  .string()
  .max(OAUTH_REDIRECT_URL_MAX)
  .refine((value) => oauthRedirectUrlProblem(value) === null, 'oauth.redirect_url_invalid');

/** `<module>:<action>`, the shape of every platform scope. No space, so a scope list cannot be smuggled in one entry. */
export const oauthScopeSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/);

export const oauthAppNameSchema = z.string().trim().min(2).max(80);

export const oauthRegisterAppInputSchema = z
  .object({
    name: oauthAppNameSchema,
    description: z.string().trim().max(500).optional(),
    logoUrl: redirectUrl.optional(),
    redirectUrls: z.array(redirectUrl).min(1).max(OAUTH_REDIRECT_URLS_MAX),
    scopes: z.array(oauthScopeSchema).min(1).max(40),
    /** A confidential app (a server) gets a client secret; a public app (a browser or native app) relies on PKCE alone. */
    confidential: z.boolean(),
    requestId: z.string().min(1).max(200),
  })
  .strict();
export type OAuthRegisterAppInput = z.infer<typeof oauthRegisterAppInputSchema>;

export const oauthAppSchema = z
  .object({
    id: z.string().guid(),
    clientId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    logoUrl: z.string().nullable(),
    redirectUrls: z.array(z.string()),
    scopes: z.array(z.string()),
    confidential: z.boolean(),
    status: z.enum(OAUTH_APP_STATUSES),
    createdAt: z.string(),
    secretRolledAt: z.string().nullable(),
  })
  .strict();
export type OAuthApp = z.infer<typeof oauthAppSchema>;

/** `clientSecret` is the only time a secret leaves the service: set on the first registration or a roll, `null` on a replay. */
export const oauthRegisterAppOutputSchema = z.object({ app: oauthAppSchema, clientSecret: z.string().nullable() }).strict();
export type OAuthRegisterAppOutput = z.infer<typeof oauthRegisterAppOutputSchema>;

export const oauthListAppsOutputSchema = z.object({ apps: z.array(oauthAppSchema) }).strict();

export const oauthRollSecretInputSchema = z.object({ appId: z.string().guid(), requestId: z.string().min(1).max(200) }).strict();

export const oauthReviewAppInputSchema = z
  .object({ appId: z.string().guid(), decision: z.enum(['approve', 'suspend']), reason: z.string().trim().max(500).optional() })
  .strict();

/** What the operator queue shows about one app. */
export const oauthReviewQueueRowSchema = oauthAppSchema.extend({ developerUserId: z.string().guid() }).strict();

/** The request the third party sent to `/oauth/authorize`. PKCE with S256 and `state` are required. */
export const oauthAuthorizeRequestSchema = z
  .object({
    responseType: z.literal('code'),
    clientId: z.string().min(1).max(100),
    redirectUri: z.string().min(1).max(OAUTH_REDIRECT_URL_MAX),
    scope: z.array(oauthScopeSchema).min(1).max(40),
    state: z.string().min(1).max(OAUTH_STATE_MAX),
    codeChallenge: z.string().regex(OAUTH_CHALLENGE_PATTERN),
    codeChallengeMethod: z.literal('S256'),
  })
  .strict();
export type OAuthAuthorizeRequest = z.infer<typeof oauthAuthorizeRequestSchema>;

/** What the consent page may show, after the server has checked client, redirect URL and scopes. */
export const oauthAuthorizePreviewSchema = z
  .object({
    appName: z.string(),
    appDescription: z.string().nullable(),
    logoUrl: z.string().nullable(),
    developerOwnAccount: z.boolean(),
    scopes: z.array(z.string()),
  })
  .strict();

export const oauthDecideInputSchema = oauthAuthorizeRequestSchema.extend({ decision: z.enum(['allow', 'deny']) }).strict();

/**
 * The owner's published lifetimes, in seconds; `null` while one is unpublished (every authorise decision and code
 * exchange then refuses `oauth.lifetime_unset`). Read by the developer's apps room so it names the blocker up front.
 */
export const oauthLifetimesSchema = z
  .object({ codeTtlSeconds: z.number().int().positive().nullable(), accessTokenTtlSeconds: z.number().int().positive().nullable() })
  .strict();
export type OAuthLifetimes = z.infer<typeof oauthLifetimesSchema>;

/** Where to send the person. For `allow` it carries `code` and `state`; for `deny` it carries `error=access_denied` and `state`. */
export const oauthDecideOutputSchema = z.object({ redirectTo: z.string() }).strict();

export const oauthTokenInputSchema = z
  .object({
    grantType: z.literal('authorization_code'),
    code: z.string().min(1).max(200),
    redirectUri: z.string().min(1).max(OAUTH_REDIRECT_URL_MAX),
    clientId: z.string().min(1).max(100),
    codeVerifier: z.string().max(200),
    clientSecret: z.string().max(200).optional(),
  })
  .strict();

export const oauthTokenOutputSchema = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().positive(),
    scope: z.array(z.string()),
  })
  .strict();
