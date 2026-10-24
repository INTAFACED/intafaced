import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import {
  listPasskeys,
  normalizePasskeyLabel,
  PasskeyManageError,
  passkeySecondStep,
  renamePasskey,
  setPasskeyPurposes,
  setPasskeySecondStep,
} from './auth/passkey-manage.js';
import { encodePurposes, parsePurposes, PASSKEY_PURPOSES } from './auth/passkey-purposes.js';
import { toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';

const row = z.object({
  credentialId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['platform', 'cross_device', 'security_key', 'unknown']),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  purposes: z.array(z.enum(PASSKEY_PURPOSES)),
});

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
    listPasskeys: scopedProcedure('identity:read')
      .input(z.object({ limit: z.number().int().min(1).max(200) }).strict())
      .output(z.object({ passkeys: z.array(row), maxPerAccount: z.number().int().nullable(), secondStep: z.boolean() }))
      .query(async ({ ctx, input }) => {
        try {
          return {
            passkeys: await listPasskeys(sql, ctx.principal.userId, input.limit),
            maxPerAccount: limits.maxPerAccount ?? null,
            secondStep: await passkeySecondStep(sql, ctx.principal.userId),
          };
        } catch (err) {
          return mapManage(err);
        }
      }),
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
    setPasskeyPurposes: scopedProcedure('identity:write')
      .input(
        z
          .object({
            credentialId: z.string().min(1).max(1024),
            purposes: z.string().max(64),
            clientRequestId: z.string().min(1).max(128),
            stepUpApprovalId: z.string().min(1).max(128).nullish(),
          })
          .strict(),
      )
      .output(row)
      .mutation(async ({ ctx, input }) => {
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
      }),
    /** Ask, or stop asking, for a passkey after the password at sign-in (I-signin-sessions-10). */
    setPasskeySecondStep: scopedProcedure('identity:write')
      .input(
        z
          .object({
            on: z.boolean(),
            clientRequestId: z.string().min(1).max(128),
            stepUpApprovalId: z.string().min(1).max(128).nullish(),
          })
          .strict(),
      )
      .output(z.object({ secondStep: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
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
      }),
  });
}
