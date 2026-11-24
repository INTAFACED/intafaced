import { TRPCError } from '@intafaced/contracts/trpc';
import { IDENTITY_OAUTH_PROCEDURES, oauthRefusalStatus } from '@intafaced/contracts/identity-oauth-procedures';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { OAuthError, type OAuthService } from './oauth.js';

/** An `OAuthError` leaves with its `oauth.*` code as the message and itself as the cause, which carries the code to the client. */
const oauthRefusal: RefusalOf = (error) =>
  error instanceof OAuthError
    ? { code: error.code, error: new TRPCError({ code: oauthRefusalStatus(error.code), message: error.code, cause: error }) }
    : undefined;

/** `oauth.*`, mounted from its records (`@intafaced/contracts/identity-oauth-procedures`), which name each guard. */
export function createOAuthRouter(service: OAuthService) {
  return mountRecords(
    IDENTITY_OAUTH_PROCEDURES,
    {
      'identity.oauth.apps.register': ({ ctx, input }) => service.registerApp(ctx, input),
      'identity.oauth.apps.list': async ({ ctx, input }) => ({ apps: await service.listApps(ctx, input.limit) }),
      'identity.oauth.apps.rollSecret': ({ ctx, input }) => service.rollSecret(ctx, input),
      'identity.oauth.apps.queue': async ({ ctx, input }) => ({ apps: await service.reviewQueue(ctx, input.status, input.limit) }),
      'identity.oauth.apps.review': ({ ctx, input }) => service.reviewApp(ctx, input),
      'identity.oauth.authorize.preview': ({ ctx, input }) => service.preview(ctx, input),
      'identity.oauth.authorize.decide': ({ ctx, input }) => service.decide(ctx, input),
      'identity.oauth.lifetimes': () => service.lifetimes(),
      'identity.oauth.token': ({ input }) => service.exchange(input),
    },
    oauthRefusal,
  );
}
