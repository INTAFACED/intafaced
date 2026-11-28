import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import type { Sql } from 'postgres';
import {
  normalizePasskeyLabel,
  PasskeyManageError,
  passkeySettings,
  renamePasskey,
  setPasskeyPurposes,
  setPasskeySecondStep,
} from './auth/passkey-manage.js';
import { encodePurposes, parsePurposes } from './auth/passkey-purposes.js';
import { toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';
import { row, IDENTITY_LIST_PASSKEYS } from '@intafaced/contracts/identity-list-passkeys-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';
import { IDENTITY_SET_PASSKEY_PURPOSES } from '@intafaced/contracts/identity-set-passkey-purposes-procedures';
import { IDENTITY_SET_PASSKEY_SECOND_STEP } from '@intafaced/contracts/identity-set-passkey-second-step-procedures';

function mapManage(err: unknown): never {
  if (err instanceof PasskeyManageError) {
    const code =
      err.code === 'auth.not_found'
        ? 'NOT_FOUND'
        : err.code === 'auth.account_frozen'
          ? 'FORBIDDEN'
          : err.code === 'auth.webauthn_not_enrolled'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.code, cause: err });
  }
  return toSecurityStepUpTrpc(err);
}

/**
 * Top-level so mergeRouters cannot nest-replace `webauthn`. `listPasskeys` shows label, kind and last use plus the
 * owner's per-account limit (null = no limit stated). `renamePasskey` is the first user of the security step-up guard:
 * validate the input, then `require`, then an idempotent write.
 */
export function createPasskeyManageRouter(sql: Sql, stepUp: SecurityStepUp, limits: { readonly maxPerAccount?: number | undefined } = {}) {
  return router({
    listPasskeys: mountRecord(
      IDENTITY_LIST_PASSKEYS,
      async ({ ctx, input }) => {
        try {
          return { ...(await passkeySettings(sql, ctx.principal.userId, input.limit)), maxPerAccount: limits.maxPerAccount ?? null };
        } catch (err) {
          return mapManage(err);
        }
      },
      codedRefusal,
    ),
    renamePasskey: scopedProcedure('identity:write')
      .input(
        z
          .object({
            credentialId: z.string().min(1).max(1024),
            label: z.string().max(256),
            clientRequestId: z.string().min(1).max(128),
            stepUpApprovalId: z.string().min(1).max(128).nullish(),
          })
          .strict(),
      )
      .output(row)
      .mutation(async ({ ctx, input }) => {
        try {
          const label = normalizePasskeyLabel(input.label);
          await stepUp.require(
            ctx.principal,
            'identity.step_up.passkey_rename',
            { credentialId: input.credentialId, label, clientRequestId: input.clientRequestId },
            input.stepUpApprovalId,
          );
          return await renamePasskey(sql, ctx.principal.userId, input.credentialId, label);
        } catch (err) {
          return mapManage(err);
        }
      }),
    /**
     * Bind one passkey to the actions it answers for (I-signin-sessions-10): `signin`, `money_out`, `security_change`.
     * Sent sorted and comma-joined, the same string the step-up hashed; '' answers for every action.
     */
    setPasskeyPurposes: mountRecord(
      IDENTITY_SET_PASSKEY_PURPOSES,
      async ({ ctx, input }) => {
        try {
          const purposes = parsePurposes(input.purposes);
          if (!purposes) throw new PasskeyManageError('identity.passkey_purposes_invalid');
          await stepUp.require(
            ctx.principal,
            'identity.step_up.passkey_purposes',
            { credentialId: input.credentialId, purposes: encodePurposes(purposes), clientRequestId: input.clientRequestId },
            input.stepUpApprovalId,
          );
          return await setPasskeyPurposes(sql, ctx.principal.userId, input.credentialId, purposes);
        } catch (err) {
          return mapManage(err);
        }
      },
      codedRefusal,
    ),
    /** Ask, or stop asking, for a passkey after the password at sign-in (I-signin-sessions-10). */
    setPasskeySecondStep: mountRecord(
      IDENTITY_SET_PASSKEY_SECOND_STEP,
      async ({ ctx, input }) => {
        try {
          await stepUp.require(
            ctx.principal,
            'identity.step_up.passkey_second_step',
            { on: input.on ? 'on' : 'off', clientRequestId: input.clientRequestId },
            input.stepUpApprovalId,
          );
          return { secondStep: await setPasskeySecondStep(sql, ctx.principal.userId, input.on) };
        } catch (err) {
          return mapManage(err);
        }
      },
      codedRefusal,
    ),
  });
}
