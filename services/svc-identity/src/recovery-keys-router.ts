import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  RECOVERY_KEY_KINDS,
  RECOVERY_LABEL_MAX,
  recoveryPublicJwkSchema,
  recoveryViewSchema,
} from '@intafaced/contracts/identity-recovery';
import { RecoveryKeyError, type RecoveryKeys } from './auth/recovery-keys.js';
import { SecurityLockError } from './auth/security-lock.js';
import { userCopy } from './user-copy.js';
import { SecurityStepUpError, toSecurityStepUpTrpc } from './auth/security-step-up.js';
import { toTrpcError } from './router.js';

const clientRequestId = z.string().min(1).max(128);
const stepUpApprovalId = z.string().min(1).max(128).nullish();
const label = z
  .string()
  .trim()
  .min(1)
  .max(RECOVERY_LABEL_MAX)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001F\u007F]+$/);

/** Staff and a key that is not there are 403 and 404; a frozen account 403; anything else the owner can fix is 412. */
function mapError(err: unknown): never {
  if (err instanceof RecoveryKeyError) {
    const code =
      err.code === 'identity.recovery_staff_forbidden' || err.code === 'auth.account_frozen'
        ? 'FORBIDDEN'
        : err.code === 'identity.recovery_key_not_found' || err.code === 'auth.not_found'
          ? 'NOT_FOUND'
          : err.code === 'identity.recovery_key_invalid'
            ? 'BAD_REQUEST'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  if (err instanceof SecurityLockError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: { code: err.code } });
  }
  if (err instanceof SecurityStepUpError) return toSecurityStepUpTrpc(err);
  throw toTrpcError(err);
}

/**
 * Top-level `recovery` (RC-identity-07, J-identity-05 #7): the owner's recovery keys, heir and threshold. Every
 * procedure is the owner's own: a staff session, an API key and a sub-account are refused before anything is read, and
 * no staff scope reaches any of them (`recovery-keys.gate.test.ts`).
 */
export function createRecoveryKeysRouter(keys: RecoveryKeys) {
  return router({
    recovery: router({
      keys: router({
        list: scopedProcedure('identity:read')
          .input(z.object({}).strict().optional())
          .output(recoveryViewSchema)
          .query(async ({ ctx }) => {
            try {
              keys.refuse(ctx.principal);
              return await keys.view(ctx.principal.userId);
            } catch (err) {
              return mapError(err);
            }
          }),
        add: scopedProcedure('identity:write')
          .input(
            z
              .object({
                kind: z.enum(RECOVERY_KEY_KINDS),
                label,
                publicKey: recoveryPublicJwkSchema,
                clientRequestId,
                stepUpApprovalId,
              })
              .strict(),
          )
          .output(recoveryViewSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await keys.add(ctx.principal, input);
            } catch (err) {
              return mapError(err);
            }
          }),
        revoke: scopedProcedure('identity:write')
          .input(z.object({ keyId: z.string().guid(), clientRequestId, stepUpApprovalId }).strict())
          .output(recoveryViewSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await keys.revoke(ctx.principal, input);
            } catch (err) {
              return mapError(err);
            }
          }),
      }),
      plan: router({
        set: scopedProcedure('identity:write')
          .input(
            z
              .object({
                heirHandle: z.string().min(1).max(33),
                threshold: z.number().int().min(1).max(1000),
                clientRequestId,
                stepUpApprovalId,
              })
              .strict(),
          )
          .output(recoveryViewSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await keys.setPlan(ctx.principal, input);
            } catch (err) {
              return mapError(err);
            }
          }),
      }),
    }),
  });
}
