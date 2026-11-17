import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  limitDeskOutputSchema,
  limitRequestCreateInputSchema,
  limitRequestListOutputSchema,
  limitRequestSchema,
  limitReviewInputSchema,
  rateTiersOutputSchema,
} from '@intafaced/contracts/api-rate-limits';
import type { Sql } from 'postgres';
import {
  createLimitRequest,
  limitDesk,
  listMyLimitRequests,
  publishedTiers,
  RateLimitError,
  reviewLimitRequest,
  type RateLimitCode,
  type RatePolicy,
} from './auth/api-rate-limits.js';
import { userCopy } from './user-copy.js';

const STATUS: Record<RateLimitCode, TRPCError['code']> = {
  'identity.rate_limits_unset': 'PRECONDITION_FAILED',
  'identity.key_not_found': 'NOT_FOUND',
  'identity.key_not_live': 'PRECONDITION_FAILED',
  'identity.limit_not_higher': 'BAD_REQUEST',
  'identity.limit_key_sandbox': 'BAD_REQUEST',
  'identity.limit_spike_invalid': 'BAD_REQUEST',
  'identity.limit_request_open': 'CONFLICT',
  'identity.limit_request_not_found': 'NOT_FOUND',
  'identity.limit_request_decided': 'CONFLICT',
  'identity.limit_grant_invalid': 'BAD_REQUEST',
  'identity.limit_review_own': 'FORBIDDEN',
  'identity.rate_grant_ceiling_unset': 'PRECONDITION_FAILED',
  'identity.rate_grant_above_ceiling': 'BAD_REQUEST',
};

function refused(err: unknown): never {
  if (err instanceof RateLimitError) {
    throw new TRPCError({ code: STATUS[err.code], message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw err;
}

function assertSignedInPerson(principal: { kid?: string | undefined; sub_account?: string | undefined }): void {
  if (principal.kid || principal.sub_account) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `${userCopy('identity.delegated_refused')} [identity.delegated_refused]` });
  }
}

/**
 * API rate limits (DV-limits-01 to 03, J-developer-06). `apiRateTiers` is public: it names no key and no account, and
 * the limits page reads it signed out. `apiLimitRequests` is the person's own requests, from a signed-in device only (a
 * key cannot ask for its own limit to go up). `apiLimitDesk` is the support reviewers' queue and decision: the support
 * operator permission, a second factor on the session, and never a key. Top level, so no merge replaces `apiKeys.*`.
 */
export function createApiRateLimitsRouter(sql: Sql, policy: RatePolicy | null) {
  return router({
    apiRateTiers: publicProcedure.output(rateTiersOutputSchema).query(() => publishedTiers(policy)),

    apiLimitRequests: router({
      create: scopedProcedure('identity:write')
        .input(limitRequestCreateInputSchema)
        .output(limitRequestSchema)
        .mutation(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await createLimitRequest(sql, policy, ctx.principal.userId, input);
          } catch (err) {
            refused(err);
          }
        }),
      listMine: scopedProcedure('identity:read')
        .output(limitRequestListOutputSchema)
        .query(async ({ ctx }) => {
          assertSignedInPerson(ctx.principal);
          return listMyLimitRequests(sql, ctx.principal.userId);
        }),
    }),

    apiLimitDesk: router({
      queue: scopedProcedure('support:ops')
        .output(limitDeskOutputSchema)
        .query(async ({ ctx }) => {
          assertSignedInPerson(ctx.principal);
          return limitDesk(sql, policy);
        }),
      review: scopedProcedure('support:ops')
        .input(limitReviewInputSchema)
        .output(limitRequestSchema)
        .mutation(async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          if (!ctx.principal.mfa) {
            throw new TRPCError({ code: 'FORBIDDEN', message: `${userCopy('auth.mfa_required')} [auth.mfa_required]` });
          }
          try {
            return await reviewLimitRequest(sql, policy, ctx.principal.userId, input);
          } catch (err) {
            refused(err);
          }
        }),
    }),
  });
}
