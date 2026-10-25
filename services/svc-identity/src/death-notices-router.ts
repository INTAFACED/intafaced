import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { DEATH_NOTICE_REPORTERS, deathNoticeViewSchema } from '@intafaced/contracts/identity-recovery';
import {
  DeathNoticeError,
  confirmDeathNotice,
  listDeathNotices,
  recordDeathNotice,
  rejectDeathNotice,
  type DeathNoticeDeps,
} from './auth/death-notices.js';
import { toTrpcError } from './router.js';
import { userCopy } from './user-copy.js';

/** Who is not an operator is 403, a missing second factor 401, an unknown notice 404, the rest 412. */
function mapError(err: unknown): never {
  if (err instanceof DeathNoticeError) {
    const code =
      err.code === 'operator.denied' || err.code === 'identity.death_notice_self'
        ? 'FORBIDDEN'
        : err.code === 'mfa.required'
          ? 'UNAUTHORIZED'
          : err.code === 'identity.death_notice_not_found'
            ? 'NOT_FOUND'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw toTrpcError(err);
}

/**
 * Top-level `deathNotice` (RC-identity-02, J-identity-05 #7). Staff doors: `admin:compliance`, and in death-notices.ts
 * a second factor on a live session. Recording changes nothing on the account; `confirm` spends a four-eyes approval
 * and freezes it.
 */
export function createDeathNoticesRouter(deps: () => DeathNoticeDeps) {
  const noticeId = z.object({ noticeId: z.string().guid() }).strict();
  return router({
    deathNotice: router({
      record: scopedProcedure('admin:compliance')
        .input(
          z
            .object({
              userId: z.string().guid(),
              caseRef: z
                .string()
                .trim()
                .min(1)
                .max(64)
                .regex(/^[A-Za-z0-9._:/-]+$/),
              reporterKind: z.enum(DEATH_NOTICE_REPORTERS),
              evidenceDocumentIds: z.array(z.string().guid()).max(20),
              receivedAt: z.string().datetime({ offset: true }),
            })
            .strict(),
        )
        .output(deathNoticeViewSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await recordDeathNotice(deps(), ctx, input);
          } catch (err) {
            return mapError(err);
          }
        }),
      forAccount: scopedProcedure('admin:compliance')
        .input(z.object({ userId: z.string().guid() }).strict())
        .output(z.array(deathNoticeViewSchema))
        .query(async ({ ctx, input }) => {
          try {
            return await listDeathNotices(deps(), ctx, input.userId);
          } catch (err) {
            return mapError(err);
          }
        }),
      reject: scopedProcedure('admin:compliance')
        .input(noticeId)
        .output(deathNoticeViewSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await rejectDeathNotice(deps(), ctx, input.noticeId);
          } catch (err) {
            return mapError(err);
          }
        }),
      confirm: scopedProcedure('admin:compliance')
        .input(z.object({ noticeId: z.string().guid(), approvalId: z.string().trim().min(1).max(128) }).strict())
        .output(deathNoticeViewSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await confirmDeathNotice(deps(), ctx, input);
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
