/**
 * The customer app's calls to the identity service's OAuth provider (`identity.oauth.*`, tRPC through the edge), each by
 * its record, so a reply that does not match the record is refused, never shown.
 */
import { oauthAppRequestId, type OAuthApp, type OAuthAuthorizeRequest, type OAuthRegisterAppInput } from '@intafaced/contracts/oauth';
import {
  IDENTITY_OAUTH_APPS_LIST,
  IDENTITY_OAUTH_APPS_REGISTER,
  IDENTITY_OAUTH_APPS_ROLL_SECRET,
  IDENTITY_OAUTH_AUTHORIZE_DECIDE,
  IDENTITY_OAUTH_AUTHORIZE_PREVIEW,
  IDENTITY_OAUTH_LIFETIMES,
} from '@intafaced/contracts/identity-oauth-procedures';
import type { ApiClient } from '../../../shared/api';

export const APPS_WINDOW = 100;

export const readApps = (api: ApiClient, signal?: AbortSignal) => api.call(IDENTITY_OAUTH_APPS_LIST, { limit: APPS_WINDOW }, { signal });

export type RegisterFields = Omit<OAuthRegisterAppInput, 'requestId'>;

/** One request id per (developer, app name), so a double click or a retry after a lost reply returns the first app. */
export const registerApp = (api: ApiClient, userId: string, fields: RegisterFields, signal?: AbortSignal) =>
  api.call(IDENTITY_OAUTH_APPS_REGISTER, { ...fields, requestId: oauthAppRequestId(userId, fields.name) }, { signal });

/** Changes only after a roll lands, so a retry of the same click repeats the same roll and shows no second secret. */
export const rollRequestId = (app: Pick<OAuthApp, 'id' | 'secretRolledAt'>) => `oauth-roll:${app.id}:${app.secretRolledAt ?? 'first'}`;

export const rollSecret = (api: ApiClient, app: Pick<OAuthApp, 'id' | 'secretRolledAt'>, signal?: AbortSignal) =>
  api.call(IDENTITY_OAUTH_APPS_ROLL_SECRET, { appId: app.id, requestId: rollRequestId(app) }, { signal });

/** The owner's code and token lifetimes; a `null` one means apps cannot sign anyone in yet (`oauth.lifetime_unset`). */
export const readLifetimes = (api: ApiClient, signal?: AbortSignal) => api.call(IDENTITY_OAUTH_LIFETIMES, undefined, { signal });

export const previewAuthorize = (api: ApiClient, request: OAuthAuthorizeRequest, signal?: AbortSignal) =>
  api.call(IDENTITY_OAUTH_AUTHORIZE_PREVIEW, request, { signal });

export const decideAuthorize = (api: ApiClient, request: OAuthAuthorizeRequest, decision: 'allow' | 'deny', signal?: AbortSignal) =>
  api.call(IDENTITY_OAUTH_AUTHORIZE_DECIDE, { ...request, decision }, { signal });
