import 'server-only';
import {
  SUPPORT_DESK_ATTACHMENT_STATUS,
  SUPPORT_DESK_SET_ATTACHMENT_SETTINGS,
} from '@intafaced/contracts/support-desk-settings-procedures';
import { founderRecordCall, type FounderCallContext, type FounderCallResult, partFrom, type Part, type PartLabels } from '@/lib/desk';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { heldTo } from './reply-check';
import { piecesInOrder, type AttachmentLimits, type AttachmentSetRequest, type AttachmentStatus } from './attachments';

export interface SupportAttachmentsView {
  readonly asOf: string;
  readonly status: Part<AttachmentStatus>;
}

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

export async function loadAttachments(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportAttachmentsView> {
  const result = heldTo(await founderRecordCall(ctx, SUPPORT_DESK_ATTACHMENT_STATUS, undefined), piecesInOrder);
  return { asOf: now.toISOString(), status: partFrom(result, (s) => s, LABELS) };
}

/** Set as the signed-in founder: svc-support takes the actor from the verified session and requires a staff lead. */
export function setAttachments(ctx: FounderCallContext, request: AttachmentSetRequest): Promise<FounderCallResult<AttachmentLimits>> {
  return founderRecordCall(ctx, SUPPORT_DESK_SET_ATTACHMENT_SETTINGS, {
    ...request.changes,
    expectedRevision: request.expectedRevision,
    reason: request.reason,
  });
}
