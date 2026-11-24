import { z } from 'zod';
import { defineProcedure, NO_INPUT, type RefusalStatus, type Refusals } from './procedure.js';
import {
  OAUTH_APP_STATUSES,
  oauthAppSchema,
  oauthAuthorizePreviewSchema,
  oauthAuthorizeRequestSchema,
  oauthDecideInputSchema,
  oauthDecideOutputSchema,
  oauthLifetimesSchema,
  oauthListAppsOutputSchema,
  oauthRegisterAppInputSchema,
  oauthRegisterAppOutputSchema,
  oauthReviewAppInputSchema,
  oauthReviewQueueRowSchema,
  oauthRollSecretInputSchema,
  oauthTokenInputSchema,
  oauthTokenOutputSchema,
  type OAuthErrorCode,
} from './oauth.js';

/**
 * svc-identity's OAuth provider (`oauth.*`), one record per call. The service mounts its whole OAuth router from here
 * (`services/svc-identity/src/oauth/oauth-router.ts`). App management and the consent decision take a signed-in person
 * (an API key or sub-account credential is refused `oauth.key_principal_refused`); the review calls take an operator with
 * `admin:compliance`; `token` is the code exchange, public, authenticated by the code, the PKCE verifier and, for a
 * confidential app, the client secret.
 */

/** The status each `oauth.*` refusal leaves with: the router sends two as FORBIDDEN, one as NOT_FOUND, every other one as PRECONDITION_FAILED. */
export function oauthRefusalStatus(code: OAuthErrorCode): RefusalStatus {
  if (code === 'oauth.operator_denied' || code === 'oauth.key_principal_refused') return 'FORBIDDEN';
  if (code === 'oauth.app_not_found') return 'NOT_FOUND';
  return 'PRECONDITION_FAILED';
}

const refusals = (codes: readonly OAuthErrorCode[]): Refusals =>
  Object.freeze(Object.fromEntries(codes.map((code) => [code, oauthRefusalStatus(code)])));

/** A signed-in person, not a service, an API key or a sub-account credential. */
const PERSON = ['oauth.operator_denied', 'oauth.key_principal_refused'] as const;
/** The checks of one authorise request: the app, its redirect URL, its status and the scopes asked. */
const REQUEST = ['oauth.app_not_found', 'oauth.redirect_uri_mismatch', 'oauth.app_not_approved', 'oauth.invalid_scope'] as const;

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

const APP_ID = '22222222-2222-4222-8222-222222222222';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const authorizeSample = {
  responseType: 'code',
  clientId: 'ifc_sample',
  redirectUri: 'https://app.example.test/callback',
  scope: ['identity:read'],
  state: 'state-1',
  codeChallenge: CHALLENGE,
  codeChallengeMethod: 'S256',
} as const;

export const IDENTITY_OAUTH_APPS_REGISTER = defineProcedure({
  ...base,
  name: 'identity.oauth.apps.register',
  kind: 'mutation',
  path: 'oauth.apps.register',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: refusals([
    ...PERSON,
    'oauth.redirect_url_invalid',
    'oauth.scope_empty',
    'oauth.invalid_scope',
    'oauth.scope_not_delegable',
    'oauth.idempotency_conflict',
    'oauth.account_not_active',
  ]),
  checks: {
    'oauth.redirect_url_invalid': {
      at: ['input.logoUrl', 'input.redirectUrls[]'],
      says: 'the URL is a canonical lowercase https:// URL with no wildcard, fragment, userinfo, default port or characters the URL parser would change',
    },
  },
  input: oauthRegisterAppInputSchema,
  output: oauthRegisterAppOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        name: 'Sample app',
        redirectUrls: ['https://app.example.test/callback'],
        scopes: ['identity:read'],
        confidential: true,
        requestId: 'oauth-app:sample',
      },
    },
    {
      verdict: 'refuse',
      input: {
        name: 'A',
        redirectUrls: ['https://app.example.test/callback'],
        scopes: ['identity:read'],
        confidential: true,
        requestId: 'x',
      },
    },
    { verdict: 'refuse', input: { name: 'Sample app', redirectUrls: [], scopes: ['identity:read'], confidential: true, requestId: 'x' } },
    {
      verdict: 'refuse',
      by: 'oauth.redirect_url_invalid',
      input: {
        name: 'Sample app',
        redirectUrls: ['http://app.example.test/callback'],
        scopes: ['identity:read'],
        confidential: true,
        requestId: 'x',
      },
    },
  ],
});

export const IDENTITY_OAUTH_APPS_LIST = defineProcedure({
  ...base,
  name: 'identity.oauth.apps.list',
  kind: 'query',
  path: 'oauth.apps.list',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: refusals(PERSON),
  input: z.object({ limit: z.number().int().min(1).max(200) }).strict(),
  output: oauthListAppsOutputSchema,
  samples: [
    { verdict: 'accept', input: { limit: 100 } },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: { limit: 201 } },
  ],
});

export const IDENTITY_OAUTH_APPS_ROLL_SECRET = defineProcedure({
  ...base,
  name: 'identity.oauth.apps.rollSecret',
  kind: 'mutation',
  path: 'oauth.apps.rollSecret',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: refusals([...PERSON, 'oauth.app_not_found', 'oauth.invalid_request', 'oauth.account_not_active']),
  input: oauthRollSecretInputSchema,
  output: oauthRegisterAppOutputSchema,
  samples: [
    { verdict: 'accept', input: { appId: APP_ID, requestId: `oauth-roll:${APP_ID}:first` } },
    { verdict: 'refuse', input: { appId: 'not-a-guid', requestId: 'oauth-roll:x:first' } },
  ],
});

export const IDENTITY_OAUTH_APPS_QUEUE = defineProcedure({
  ...base,
  name: 'identity.oauth.apps.queue',
  kind: 'query',
  path: 'oauth.apps.queue',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: refusals(['oauth.operator_denied']),
  input: z.object({ status: z.enum(OAUTH_APP_STATUSES), limit: z.number().int().min(1).max(200) }).strict(),
  output: z.object({ apps: z.array(oauthReviewQueueRowSchema) }).strict(),
  samples: [
    { verdict: 'accept', input: { status: 'pending', limit: 50 } },
    { verdict: 'refuse', input: { status: 'deleted', limit: 50 } },
  ],
});

export const IDENTITY_OAUTH_APPS_REVIEW = defineProcedure({
  ...base,
  name: 'identity.oauth.apps.review',
  kind: 'mutation',
  path: 'oauth.apps.review',
  access: { caller: 'scope', scope: 'admin:compliance' },
  refusals: refusals(['oauth.operator_denied', 'oauth.app_not_found']),
  input: oauthReviewAppInputSchema,
  output: oauthAppSchema,
  samples: [
    { verdict: 'accept', input: { appId: APP_ID, decision: 'approve' } },
    { verdict: 'refuse', input: { appId: APP_ID, decision: 'delete' } },
  ],
});

export const IDENTITY_OAUTH_AUTHORIZE_PREVIEW = defineProcedure({
  ...base,
  name: 'identity.oauth.authorize.preview',
  kind: 'query',
  path: 'oauth.authorize.preview',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: refusals([...PERSON, 'oauth.lifetime_unset', 'oauth.account_not_active', ...REQUEST]),
  input: oauthAuthorizeRequestSchema,
  output: oauthAuthorizePreviewSchema,
  samples: [
    { verdict: 'accept', input: authorizeSample },
    { verdict: 'refuse', input: { ...authorizeSample, codeChallengeMethod: 'plain' } },
  ],
});

export const IDENTITY_OAUTH_AUTHORIZE_DECIDE = defineProcedure({
  ...base,
  name: 'identity.oauth.authorize.decide',
  kind: 'mutation',
  path: 'oauth.authorize.decide',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: refusals([...PERSON, 'oauth.lifetime_unset', 'oauth.account_not_active', ...REQUEST]),
  input: oauthDecideInputSchema,
  output: oauthDecideOutputSchema,
  samples: [
    { verdict: 'accept', input: { ...authorizeSample, decision: 'allow' } },
    { verdict: 'refuse', input: { ...authorizeSample, decision: 'maybe' } },
  ],
});

export const IDENTITY_OAUTH_LIFETIMES = defineProcedure({
  ...base,
  name: 'identity.oauth.lifetimes',
  kind: 'query',
  path: 'oauth.lifetimes',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: oauthLifetimesSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_OAUTH_TOKEN = defineProcedure({
  ...base,
  name: 'identity.oauth.token',
  kind: 'mutation',
  path: 'oauth.token',
  access: { caller: 'public' },
  refusals: refusals([
    'oauth.lifetime_unset',
    'oauth.invalid_client',
    'oauth.app_not_approved',
    'oauth.invalid_grant',
    'oauth.account_not_active',
  ]),
  input: oauthTokenInputSchema,
  output: oauthTokenOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        grantType: 'authorization_code',
        code: 'ifcc_sample',
        redirectUri: 'https://app.example.test/callback',
        clientId: 'ifc_sample',
        codeVerifier: 'a'.repeat(43),
      },
    },
    {
      verdict: 'refuse',
      input: {
        grantType: 'password',
        code: 'ifcc_sample',
        redirectUri: 'https://app.example.test/callback',
        clientId: 'ifc_sample',
        codeVerifier: 'x',
      },
    },
  ],
});

export const IDENTITY_OAUTH_PROCEDURES = [
  IDENTITY_OAUTH_APPS_REGISTER,
  IDENTITY_OAUTH_APPS_LIST,
  IDENTITY_OAUTH_APPS_ROLL_SECRET,
  IDENTITY_OAUTH_APPS_QUEUE,
  IDENTITY_OAUTH_APPS_REVIEW,
  IDENTITY_OAUTH_AUTHORIZE_PREVIEW,
  IDENTITY_OAUTH_AUTHORIZE_DECIDE,
  IDENTITY_OAUTH_LIFETIMES,
  IDENTITY_OAUTH_TOKEN,
] as const;
