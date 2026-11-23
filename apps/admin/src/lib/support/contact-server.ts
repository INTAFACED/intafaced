import 'server-only';
import { SUPPORT_CONTACT_CHANNELS, SUPPORT_DESK_SET_CONTACT_CHANNELS } from '@intafaced/contracts/support-desk-settings-procedures';
import { founderRecordCall, type FounderCallContext, type FounderCallResult, partFrom, type Part, type PartLabels } from '@/lib/desk';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import type { ContactChannels, ContactSetRequest } from './contact';

export interface SupportContactView {
  readonly asOf: string;
  readonly contact: Part<ContactChannels>;
}

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

export async function loadContact(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportContactView> {
  const result = await founderRecordCall(ctx, SUPPORT_CONTACT_CHANNELS, undefined);
  return { asOf: now.toISOString(), contact: partFrom(result, (c) => c, LABELS) };
}

/** Set as the signed-in founder: svc-support takes the actor from the verified session and requires a staff lead. */
export function setContact(ctx: FounderCallContext, request: ContactSetRequest): Promise<FounderCallResult<ContactChannels>> {
  return founderRecordCall(ctx, SUPPORT_DESK_SET_CONTACT_CHANNELS, {
    ...request.changes,
    expectedRevision: request.expectedRevision,
    reason: request.reason,
  });
}
