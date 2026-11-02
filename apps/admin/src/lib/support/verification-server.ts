import 'server-only';
import { supportVerificationCheckSchema, supportVerificationChecksSchema } from '@intafaced/contracts/support-verification-checks';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { DISCLOSURE_PROCEDURE, type SupportVerificationView, type VerificationRequest } from './verification';

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

/** The checks on one request, read as the signed-in founder. */
export async function loadVerification(
  ctx: FounderCallContext,
  ticketId: string,
  now: Date = new Date(),
): Promise<SupportVerificationView> {
  const result = await founderCall(ctx, 'support', 'verificationChecks', 'GET', { ticketId }, parseWith(supportVerificationChecksSchema));
  return { asOf: now.toISOString(), checks: partFrom(result, (c) => c, LABELS) };
}

/**
 * Record a check, or ask for a read behind the gate. A read has no success answer svc-support can give today, so any
 * answer that is not a refusal is read as invalid, never shown as a balance.
 */
export function runVerification(ctx: FounderCallContext, request: VerificationRequest): Promise<FounderCallResult<unknown>> {
  if (request.action === 'check') {
    return founderCall(
      ctx,
      'support',
      'recordVerificationCheck',
      'POST',
      { ticketId: request.ticketId, kind: 'owned_record', recordKind: request.recordKind, recordId: request.recordId },
      parseWith(supportVerificationCheckSchema),
    );
  }
  return founderCall(ctx, 'support', DISCLOSURE_PROCEDURE[request.what], 'GET', { ticketId: request.ticketId }, () => null);
}
