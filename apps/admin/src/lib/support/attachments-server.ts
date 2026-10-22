import 'server-only';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import {
  readAttachmentLimits,
  readAttachmentStatus,
  type AttachmentLimits,
  type AttachmentSetRequest,
  type AttachmentStatus,
} from './attachments';

export interface SupportAttachmentsView {
  readonly asOf: string;
  readonly status: Part<AttachmentStatus>;
}

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

export async function loadAttachments(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportAttachmentsView> {
  const result = await founderCall(ctx, 'support', 'attachmentStatus', 'GET', undefined, readAttachmentStatus);
  return { asOf: now.toISOString(), status: partFrom(result, (s) => s, LABELS) };
}

/** Set as the signed-in founder: svc-support takes the actor from the verified session and requires a staff lead. */
export function setAttachments(ctx: FounderCallContext, request: AttachmentSetRequest): Promise<FounderCallResult<AttachmentLimits>> {
  return founderCall(
    ctx,
    'support',
    'setAttachmentSettings',
    'POST',
    { ...request.changes, expectedRevision: request.expectedRevision, reason: request.reason },
    readAttachmentLimits,
  );
}
