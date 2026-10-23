import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AccountDirectoryError, accountCounts, searchAccounts } from './account-directory.js';
import { OperatorApiKeyError, revokeApiKeyForUser } from './operator-api-keys.js';
import { OperatorSessionError, listSessionsForUser, revokeSessionsForUser } from './operator-sessions.js';

const directoryRow = z
  .object({
    id: z.string().uuid(),
    handle: z.string(),
    status: z.enum(['active', 'frozen', 'closed']),
    created: z.string().datetime({ offset: true }),
    kycTier: z.enum(['none', 'basic', 'full', 'institutional']),
    restrictedAreas: z.array(z.enum(['identity', 'trading'])),
    emailMasked: z.string(),
  })
  .strict();

function directoryError(error: unknown): never {
  if (error instanceof AccountDirectoryError) {
    const code = error.code === 'operator.denied' ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

function sessionError(error: unknown): never {
  if (error instanceof OperatorSessionError) {
    const code = error.code === 'mfa.required' ? 'UNAUTHORIZED' : error.code === 'operator.denied' ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

function apiKeyError(error: unknown): never {
  if (error instanceof OperatorApiKeyError) {
    const code =
      error.code === 'mfa.required'
        ? 'UNAUTHORIZED'
        : error.code === 'operator.denied'
          ? 'FORBIDDEN'
          : error.code === 'auth.not_found'
            ? 'NOT_FOUND'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

export function createOperatorOpsRouter(sql: Sql) {
  return router({
    accountDirectory: router({
      search: scopedProcedure('admin:compliance')
        .input(
          z
            .object({
              email: z.string().max(320).optional(),
              handle: z.string().max(32).optional(),
              cursor: z.string().max(512).optional(),
            })
            .strict(),
        )
        .output(z.object({ rows: z.array(directoryRow), nextCursor: z.string().nullable() }).strict())
        .query(async ({ ctx, input }) => {
          try {
            return await searchAccounts(sql, ctx, input);
          } catch (error) {
            directoryError(error);
          }
        }),
      counts: scopedProcedure('admin:read')
        .input(z.object({}).strict())
        .output(
          z
            .object({
              asOf: z.string().datetime({ offset: true }),
              byStatus: z.object({ active: z.number().int(), frozen: z.number().int(), closed: z.number().int() }).strict(),
            })
            .strict(),
        )
        .query(async ({ ctx }) => {
          try {
            return await accountCounts(sql, ctx);
          } catch (error) {
            directoryError(error);
          }
        }),
    }),
    sessions: router({
      listForUser: scopedProcedure('admin:compliance')
        .input(z.object({ userId: z.string().uuid() }).strict())
        .output(
          z
            .object({
              sessions: z.array(
                z
                  .object({
                    deviceLabel: z.string().nullable(),
                    created: z.string().datetime({ offset: true }),
                    lastSeen: z.string().datetime({ offset: true }),
                    state: z.enum(['live', 'revoked', 'expired']),
                  })
                  .strict(),
              ),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) => {
          try {
            return await listSessionsForUser(sql, ctx, input.userId);
          } catch (error) {
            sessionError(error);
          }
        }),
      revokeForUser: scopedProcedure('admin:write')
        .input(
          z
            .object({
              userId: z.string().uuid(),
              approvalId: z.string().min(1).max(128),
              clientRequestId: z.string().min(1).max(128),
            })
            .strict(),
        )
        .output(
          z
            .object({
              userId: z.string().uuid(),
              revokedSessionCount: z.number().int(),
              approvalId: z.string(),
              clientRequestId: z.string(),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            return await revokeSessionsForUser(sql, ctx, input);
          } catch (error) {
            sessionError(error);
          }
        }),
    }),
    /** Support-agent and founder-ops revoke of one customer key (DV-keys-04, ENGINE KS-11). Never returns a secret. */
    apiKeyOps: router({
      revoke: scopedProcedure('admin:write')
        .input(
          z
            .object({
              userId: z.string().uuid(),
              keyId: z.string().uuid(),
              reason: z.string().max(500),
              clientRequestId: z.string().max(128),
            })
            .strict(),
        )
        .output(
          z
            .object({
              userId: z.string().uuid(),
              keyId: z.string().uuid(),
              changed: z.boolean(),
              revocation: z
                .object({ actorId: z.string().uuid(), reason: z.string(), revokedAt: z.string().datetime({ offset: true }) })
                .strict()
                .nullable(),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            return await revokeApiKeyForUser(sql, ctx, input);
          } catch (error) {
            apiKeyError(error);
          }
        }),
    }),
  });
}
