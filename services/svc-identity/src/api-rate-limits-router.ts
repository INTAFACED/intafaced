import { router, TRPCError } from '@intafaced/contracts/trpc';
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
import { IDENTITY_API_RATE_TIERS } from '@intafaced/contracts/identity-api-rate-tiers-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';
import { IDENTITY_API_LIMIT_DESK_QUEUE, IDENTITY_API_LIMIT_DESK_REVIEW } from '@intafaced/contracts/identity-api-limit-desk-procedures';
import {
  IDENTITY_API_LIMIT_REQUESTS_LIST_MINE,
  IDENTITY_API_LIMIT_REQUESTS_CREATE,
} from '@intafaced/contracts/identity-api-limit-requests-procedures';

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
    apiRateTiers: mountRecord(IDENTITY_API_RATE_TIERS, () => publishedTiers(policy), codedRefusal),

    apiLimitRequests: router({
      create: mountRecord(
        IDENTITY_API_LIMIT_REQUESTS_CREATE,
        async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          try {
            return await createLimitRequest(sql, policy, ctx.principal.userId, input);
          } catch (err) {
            refused(err);
          }
        },
        codedRefusal,
      ),
      listMine: mountRecord(
        IDENTITY_API_LIMIT_REQUESTS_LIST_MINE,
        async ({ ctx }) => {
          assertSignedInPerson(ctx.principal);
          return listMyLimitRequests(sql, ctx.principal.userId);
        },
        codedRefusal,
      ),
    }),

    apiLimitDesk: router({
      queue: mountRecord(
        IDENTITY_API_LIMIT_DESK_QUEUE,
        async ({ ctx }) => {
          assertSignedInPerson(ctx.principal);
          return limitDesk(sql, policy);
        },
        codedRefusal,
      ),
      review: mountRecord(
        IDENTITY_API_LIMIT_DESK_REVIEW,
        async ({ ctx, input }) => {
          assertSignedInPerson(ctx.principal);
          if (!ctx.principal.mfa) {
            throw new TRPCError({ code: 'FORBIDDEN', message: `${userCopy('auth.mfa_required')} [auth.mfa_required]` });
          }
          try {
            return await reviewLimitRequest(sql, policy, ctx.principal.userId, input);
          } catch (err) {
            refused(err);
          }
        },
        codedRefusal,
      ),
    }),
  });
}
