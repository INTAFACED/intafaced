import { z } from 'zod';
import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
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
} from '@intafaced/contracts/oauth';
import { OAuthError, type OAuthService } from './oauth.js';

const FORBIDDEN = new Set(['oauth.operator_denied', 'oauth.key_principal_refused']);
const NOT_FOUND = new Set(['oauth.app_not_found']);

/** The `oauth.*` code is the message; `cause.code` carries it to the client. */
function oauthFailure(error: unknown): never {
  if (error instanceof OAuthError) {
    const code = FORBIDDEN.has(error.code) ? 'FORBIDDEN' : NOT_FOUND.has(error.code) ? 'NOT_FOUND' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: error.code, cause: error });
  }
  throw error;
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    return oauthFailure(error);
  }
}

/**
 * `identity.oauth.*`. App management and the consent decision need a signed-in session (an API key is refused);
 * the review calls need an operator session. `token` is the code exchange: it has no session because the caller is
 * the app's server or a public client, and it authenticates by the code, the PKCE verifier and, for a confidential
 * app, the client secret.
 */
export function createOAuthRouter(service: OAuthService) {
  return router({
    oauth: router({
      apps: router({
        register: scopedProcedure('identity:write')
          .input(oauthRegisterAppInputSchema)
          .output(oauthRegisterAppOutputSchema)
          .mutation(({ ctx, input }) => guarded(() => service.registerApp(ctx, input))),
        list: scopedProcedure('identity:read')
          .input(z.object({ limit: z.number().int().min(1).max(200) }).strict())
          .output(oauthListAppsOutputSchema)
          .query(({ ctx, input }) => guarded(async () => ({ apps: await service.listApps(ctx, input.limit) }))),
        rollSecret: scopedProcedure('identity:write')
          .input(oauthRollSecretInputSchema)
          .output(oauthRegisterAppOutputSchema)
          .mutation(({ ctx, input }) => guarded(() => service.rollSecret(ctx, input))),
        queue: scopedProcedure('admin:compliance')
          .input(z.object({ status: z.enum(OAUTH_APP_STATUSES), limit: z.number().int().min(1).max(200) }).strict())
          .output(z.object({ apps: z.array(oauthReviewQueueRowSchema) }).strict())
          .query(({ ctx, input }) => guarded(async () => ({ apps: await service.reviewQueue(ctx, input.status, input.limit) }))),
        review: scopedProcedure('admin:compliance')
          .input(oauthReviewAppInputSchema)
          .output(oauthAppSchema)
          .mutation(({ ctx, input }) => guarded(() => service.reviewApp(ctx, input))),
      }),
      authorize: router({
        preview: scopedProcedure('identity:read')
          .input(oauthAuthorizeRequestSchema)
          .output(oauthAuthorizePreviewSchema)
          .query(({ ctx, input }) => guarded(() => service.preview(ctx, input))),
        decide: scopedProcedure('identity:write')
          .input(oauthDecideInputSchema)
          .output(oauthDecideOutputSchema)
          .mutation(({ ctx, input }) => guarded(() => service.decide(ctx, input))),
      }),
      lifetimes: scopedProcedure('identity:read')
        .output(oauthLifetimesSchema)
        .query(() => service.lifetimes()),
      token: publicProcedure
        .input(oauthTokenInputSchema)
        .output(oauthTokenOutputSchema)
        .mutation(({ input }) => guarded(() => service.exchange(input))),
    }),
  });
}
