import 'server-only';
import {
  SUPPORT_DESK_READ_DISCLOSURE,
  SUPPORT_DESK_RECORD_VERIFICATION_CHECK,
  SUPPORT_DESK_VERIFICATION_CHECKS,
} from '@intafaced/contracts/support-desk-settings-procedures';
import { founderRecordCall, type FounderCallContext, type FounderCallResult, partFrom, type PartLabels } from '@/lib/desk';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import type { SupportVerificationView, VerificationRequest } from './verification';

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
  const result = await founderRecordCall(ctx, SUPPORT_DESK_VERIFICATION_CHECKS, { ticketId });
  return { asOf: now.toISOString(), checks: partFrom(result, (c) => c, LABELS) };
}

/**
 * Record a check, or ask for a read behind the gate. A read has no success answer svc-support can give today, so any
 * answer that is not a refusal is read as invalid, never shown as a balance.
 */
export function runVerification(ctx: FounderCallContext, request: VerificationRequest): Promise<FounderCallResult<unknown>> {
  if (request.action === 'check') {
    return founderRecordCall(ctx, SUPPORT_DESK_RECORD_VERIFICATION_CHECK, {
      ticketId: request.ticketId,
      kind: request.kind,
      value: request.value,
    });
  }
  return founderRecordCall(ctx, SUPPORT_DESK_READ_DISCLOSURE, { ticketId: request.ticketId, kind: request.what });
}
