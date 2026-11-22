import { TRPCError } from '@trpc/server';
import type { SupportVerificationErrorCode } from '@intafaced/contracts';
import { SUPPORT_VERIFICATION_ERROR_CODES, supportTicketOnlyInputSchema } from '@intafaced/contracts/support-verification-checks';
import { scopedProcedure } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  SUPPORT_DESK_READ_DISCLOSURE,
  SUPPORT_DESK_RECORD_VERIFICATION_CHECK,
  SUPPORT_DESK_VERIFICATION_CHECKS,
} from '@intafaced/contracts/support-desk-settings-procedures';
import type { VerificationChecks } from './verification-checks.js';
import { requireSupportOps, SupportError } from './support-service.js';
import { supportRefusal } from './record-refusal.js';
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
    recordVerificationCheck: mountRecord(
      SUPPORT_DESK_RECORD_VERIFICATION_CHECK,
      async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal);
          return await checks.record(ctx.principal.userId, input);
        } catch (err) {
          throw asGate(err);
        }
      },
      supportRefusal,
    ),

    verificationChecks: mountRecord(
      SUPPORT_DESK_VERIFICATION_CHECKS,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return checks.list(ctx.principal.userId, input.ticketId);
      },
      supportRefusal,
    ),

    readDisclosure: mountRecord(
      SUPPORT_DESK_READ_DISCLOSURE,
      async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal);
          return await checks.disclose(ctx.principal.userId, input.ticketId, input.kind);
        } catch (err) {
          throw asGate(err);
        }
      },
      supportRefusal,
    ),

    customerBalance: scopedProcedure('support:ops')
      .input(supportTicketOnlyInputSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal);
          return await checks.disclose(ctx.principal.userId, input.ticketId, 'balance');
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

/**
 * A gate refusal in its own status, keeping its code first in the message, then its detail (the owner it waits on, or the
 * checks matched). Anything else is returned unchanged: a door mounted from a record lets it reach `supportRefusal`.
 */
function asGate(err: unknown): unknown {
  if (err instanceof SupportError && isGateCode(err.code)) {
    const message = err.missingKey ? `${userCopy(err.code)} ${err.missingKey}` : userCopy(err.code);
    return new TRPCError({ code: HTTP[err.code], message, cause: err });
  }
  return err;
}

/** `asGate`, then every other SupportError in its wire form, for a door not mounted from a record. */
function mapCheck(err: unknown): never {
  const gate = asGate(err);
  if (gate !== err) throw gate;
  return mapError(err);
}
