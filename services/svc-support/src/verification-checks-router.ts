import { TRPCError } from '@trpc/server';
import {
  SUPPORT_VERIFICATION_ERROR_CODES,
  scopedProcedure,
  supportDisclosureReadInputSchema,
  supportRecordVerificationCheckInputSchema,
  supportTicketOnlyInputSchema,
  supportVerificationCheckSchema,
  supportVerificationChecksSchema,
  type SupportVerificationErrorCode,
} from '@intafaced/contracts';
import type { VerificationChecks } from './verification-checks.js';
import { requireSupportOps, SupportError } from './support-service.js';
import { mapError } from './router.js';
import { userCopy } from './user-copy.js';

/**
 * Balance disclosure gate (RC-support-public-01, J-support-public-20 #2). Every procedure is the desk's (`support:ops`, an
 * interactive-only scope, so never an API key) and takes a ticket, never a customer: the customer comes off the ticket, and
 * a ticket outside the caller's desk scope answers as not found. `readDisclosure` (balance, fills or destination) and
 * `customerBalance` (the journey's name for the balance read) have no success answer: before the two matched checks they
 * refuse `support.verification_checks_required`, after them `support.disclosure_unwired` naming the owner of the read.
 */
export function verificationCheckProcedures(checks: VerificationChecks) {
  return {
    recordVerificationCheck: scopedProcedure('support:ops')
      .input(supportRecordVerificationCheckInputSchema)
      .output(supportVerificationCheckSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await checks.record(ctx.principal!.userId, input);
        } catch (err) {
          mapCheck(err);
        }
      }),

    verificationChecks: scopedProcedure('support:ops')
      .input(supportTicketOnlyInputSchema)
      .output(supportVerificationChecksSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await checks.list(ctx.principal!.userId, input.ticketId);
        } catch (err) {
          mapCheck(err);
        }
      }),

    readDisclosure: scopedProcedure('support:ops')
      .input(supportDisclosureReadInputSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await checks.disclose(ctx.principal!.userId, input.ticketId, input.kind);
        } catch (err) {
          mapCheck(err);
        }
      }),

    customerBalance: scopedProcedure('support:ops')
      .input(supportTicketOnlyInputSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await checks.disclose(ctx.principal!.userId, input.ticketId, 'balance');
        } catch (err) {
          mapCheck(err);
        }
      }),
  };
}

const HTTP: Record<SupportVerificationErrorCode, TRPCError['code']> = {
  'support.verification_checks_required': 'PRECONDITION_FAILED',
  'support.verification_mismatch': 'BAD_REQUEST',
  'support.disclosure_unwired': 'PRECONDITION_FAILED',
  'support.verification_attempts_unset': 'PRECONDITION_FAILED',
  'support.verification_attempts_exhausted': 'TOO_MANY_REQUESTS',
};

const isGateCode = (code: string): code is SupportVerificationErrorCode =>
  (SUPPORT_VERIFICATION_ERROR_CODES as readonly string[]).includes(code);

/** A gate refusal keeps its code first in the message, then its detail (the owner it waits on, or the checks matched). */
function mapCheck(err: unknown): never {
  if (err instanceof SupportError && isGateCode(err.code)) {
    const message = err.missingKey ? `${userCopy(err.code)} ${err.missingKey}` : userCopy(err.code);
    throw new TRPCError({ code: HTTP[err.code], message, cause: err });
  }
  return mapError(err);
}
