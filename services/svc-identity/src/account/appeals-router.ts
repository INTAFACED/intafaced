import { z } from 'zod';
import type { Context } from '@intafaced/contracts';
import { appealDecideInputSchema, appealForStaffSchema } from '@intafaced/contracts/identity-appeals';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { AppealError, type AccountAppeals, type AppealErrorCode } from './appeals.js';
import { userCopy } from '../user-copy.js';
import type { AuthService } from '../auth/auth-service.js';
import { toTrpcError } from '../router.js';
import {
  IDENTITY_ACCOUNT_APPEAL_MINE,
  IDENTITY_ACCOUNT_APPEAL_SUBMIT,
  IDENTITY_ACCOUNT_APPEAL_SUBMIT_SIGNED_OUT,
} from '@intafaced/contracts/identity-account-appeal-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

const STATUS: Readonly<Record<AppealErrorCode, TRPCError['code']>> = {
  'identity.appeal_window_unset': 'PRECONDITION_FAILED',
  'identity.appeal_window_closed': 'PRECONDITION_FAILED',
  'identity.appeal_no_restriction': 'PRECONDITION_FAILED',
  'identity.appeal_open': 'CONFLICT',
  'identity.appeal_request_conflict': 'CONFLICT',
  'identity.appeal_not_allowed': 'PRECONDITION_FAILED',
  'identity.appeal_sign_in': 'PRECONDITION_FAILED',
  'identity.appeal_reasons_unset': 'PRECONDITION_FAILED',
  'identity.appeal_reason_unlisted': 'BAD_REQUEST',
  'identity.appeal_not_found': 'NOT_FOUND',
  'identity.appeal_decided': 'CONFLICT',
  'identity.appeal_version_conflict': 'CONFLICT',
  'identity.appeal_decider_restricted': 'FORBIDDEN',
  'identity.appeal_setter_unknown': 'PRECONDITION_FAILED',
  'identity.appeal_restriction_changed': 'CONFLICT',
  'identity.appeal_lift_refused': 'PRECONDITION_FAILED',
  'identity.appeal_lift_unconfigured': 'PRECONDITION_FAILED',
};

function mapError(err: unknown): never {
  if (err instanceof AppealError) {
    throw new TRPCError({
      code: STATUS[err.code],
      message: `${userCopy(err.code)} [${err.code}]`,
      cause: err.detail ? { code: err.code, details: { control: err.detail } } : { code: err.code },
    });
  }
  throw toTrpcError(err);
}

/** The person's own appeals: a live session of the account holder, never an API key or a sub-account. */
function refuseDelegated(ctx: Context): void {
  const p = ctx.principal;
  if (!p || p.kid || p.sub_account)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Sign in to the main account to appeal',
      cause: { code: 'identity.delegated_refused' },
    });
}

/** A decision is a person's at the console with a second factor: never a service, an API key or a sub-account. */
function refuseNonOperator(ctx: Context): void {
  const p = ctx.principal;
  if (!p || p.kid || p.sub_account)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Appeal decisions need a person signed in', cause: { code: 'operator.denied' } });
  if (!p.mfa) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'A second factor is required', cause: { code: 'mfa.required' } });
}

/**
 * `accountAppeal` (I-account-lifecycle-12). `submit` and `mine` are the account holder's, `submitSignedOut` a
 * staff-frozen holder's; `queue` and `decide` are
 * compliance's (`admin:compliance`, a person with a second factor). Mounted on its own so it shares no file with the
 * `account.*` change doors or `accountStatus`.
 */
export function createAppealsRouter(appeals: AccountAppeals, auth: Pick<AuthService, 'proveAppellant'>) {
  return router({
    accountAppeal: router({
      /**
       * A staff-frozen person cannot sign in, so their appeal is filed here, signed out: the sign-in name and password
       * prove the account exactly as sign-in does (lockout, one answer for an unknown name and a wrong password), and only
       * then is the state named.
       */
      submitSignedOut: mountRecord(
        IDENTITY_ACCOUNT_APPEAL_SUBMIT_SIGNED_OUT,
        async ({ input }) => {
          try {
            const proved = await auth.proveAppellant({ identifier: input.identifier, password: input.password });
            return await appeals.submitSignedOut(proved, { text: input.text, clientRequestId: input.clientRequestId });
          } catch (err) {
            return mapError(err);
          }
        },
        codedRefusal,
      ),
      submit: mountRecord(
        IDENTITY_ACCOUNT_APPEAL_SUBMIT,
        async ({ ctx, input }) => {
          refuseDelegated(ctx);
          try {
            return await appeals.submit(ctx.principal.userId.toLowerCase(), input);
          } catch (err) {
            return mapError(err);
          }
        },
        codedRefusal,
      ),
      mine: mountRecord(
        IDENTITY_ACCOUNT_APPEAL_MINE,
        ({ ctx }) => {
          refuseDelegated(ctx);
          return appeals.mine(ctx.principal.userId.toLowerCase());
        },
        codedRefusal,
      ),
      queue: scopedProcedure('admin:compliance', { person: true })
        .input(z.object({ limit: z.number().int().min(1).max(100) }).strict())
        .output(z.object({ appeals: z.array(appealForStaffSchema) }))
        .query(async ({ ctx, input }) => {
          refuseNonOperator(ctx);
          return { appeals: await appeals.queue(input.limit) };
        }),
      decide: scopedProcedure('admin:compliance', { person: true })
        .input(appealDecideInputSchema)
        .output(appealForStaffSchema)
        .mutation(async ({ ctx, input }) => {
          refuseNonOperator(ctx);
          try {
            return await appeals.decide(ctx, input);
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
