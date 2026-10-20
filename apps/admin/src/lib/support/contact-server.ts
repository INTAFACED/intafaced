import 'server-only';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { readContactChannels, type ContactChannels, type ContactSetRequest } from './contact';

export interface SupportContactView {
  readonly asOf: string;
  readonly contact: Part<ContactChannels>;
}

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

export async function loadContact(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportContactView> {
  const result = await founderCall(ctx, 'support', 'contactChannels', 'GET', undefined, readContactChannels);
  return { asOf: now.toISOString(), contact: partFrom(result, (c) => c, LABELS) };
}

/** Set as the signed-in founder: svc-support takes the actor from the verified session and requires a staff lead. */
export function setContact(ctx: FounderCallContext, request: ContactSetRequest): Promise<FounderCallResult<ContactChannels>> {
  return founderCall(
    ctx,
    'support',
    'setContactChannels',
    'POST',
    { ...request.changes, expectedRevision: request.expectedRevision, reason: request.reason },
    readContactChannels,
  );
}
