/**
 * The customer app's calls to the identity service's OAuth provider (`identity.oauth.*`, tRPC through the edge). The shapes
 * are the contract's, so a reply that does not match is refused, never shown.
 */
import {
  oauthAppRequestId,
  oauthAuthorizePreviewSchema,
  oauthDecideOutputSchema,
  oauthLifetimesSchema,
  oauthListAppsOutputSchema,
  oauthRegisterAppOutputSchema,
  type OAuthApp,
  type OAuthAuthorizeRequest,
  type OAuthRegisterAppInput,
} from '@intafaced/contracts/oauth';
import type { ApiClient } from '../../../shared/api';

export const APPS_WINDOW = 100;

export const readApps = (api: ApiClient, signal?: AbortSignal) =>
  api.query('identity', 'oauth.apps.list', { limit: APPS_WINDOW }, oauthListAppsOutputSchema, { signal });

export type RegisterFields = Omit<OAuthRegisterAppInput, 'requestId'>;

/** One request id per (developer, app name), so a double click or a retry after a lost reply returns the first app. */
export const registerApp = (api: ApiClient, userId: string, fields: RegisterFields, signal?: AbortSignal) =>
  api.mutate(
    'identity',
    'oauth.apps.register',
    { ...fields, requestId: oauthAppRequestId(userId, fields.name) },
    oauthRegisterAppOutputSchema,
    {
      signal,
    },
  );

/** Changes only after a roll lands, so a retry of the same click repeats the same roll and shows no second secret. */
export const rollRequestId = (app: Pick<OAuthApp, 'id' | 'secretRolledAt'>) => `oauth-roll:${app.id}:${app.secretRolledAt ?? 'first'}`;

export const rollSecret = (api: ApiClient, app: Pick<OAuthApp, 'id' | 'secretRolledAt'>, signal?: AbortSignal) =>
  api.mutate('identity', 'oauth.apps.rollSecret', { appId: app.id, requestId: rollRequestId(app) }, oauthRegisterAppOutputSchema, {
    signal,
  });

/** The owner's code and token lifetimes; a `null` one means apps cannot sign anyone in yet (`oauth.lifetime_unset`). */
export const readLifetimes = (api: ApiClient, signal?: AbortSignal) =>
  api.query('identity', 'oauth.lifetimes', undefined, oauthLifetimesSchema, { signal });

export const previewAuthorize = (api: ApiClient, request: OAuthAuthorizeRequest, signal?: AbortSignal) =>
  api.query('identity', 'oauth.authorize.preview', request, oauthAuthorizePreviewSchema, { signal });

export const decideAuthorize = (api: ApiClient, request: OAuthAuthorizeRequest, decision: 'allow' | 'deny', signal?: AbortSignal) =>
  api.mutate('identity', 'oauth.authorize.decide', { ...request, decision }, oauthDecideOutputSchema, { signal });
