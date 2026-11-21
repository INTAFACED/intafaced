import 'server-only';
import { SUPPORT_DESK_ATTACH_OPS, SUPPORT_DESK_ATTACHMENT_DOWNLOAD_OPS } from '@intafaced/contracts/support-desk-settings-procedures';
import {
  founderCall,
  founderRecordCall,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type Part,
  type PartLabels,
} from '@/lib/desk';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { heldTo } from './reply-check';
import {
  addedByOperatorOn,
  downloadServes,
  FILES_PAGE,
  readTicketFiles,
  type FileDownload,
  type TicketFile,
  type UploadParams,
} from './files';

export interface TicketFilesView {
  readonly asOf: string;
  readonly files: Part<TicketFile[]>;
}

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

export async function loadTicketFiles(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<TicketFilesView> {
  const result = await founderCall(ctx, 'support', 'ticketAttachments', 'GET', { ticketId, limit: FILES_PAGE }, (raw) => {
    const rows = readTicketFiles(raw);
    // Every row must be on the ticket that was asked for.
    return rows && rows.every((row) => row.ticketId === ticketId) ? rows : null;
  });
  return { asOf: now.toISOString(), files: partFrom(result, (rows) => rows, LABELS) };
}

/** As the signed-in founder: svc-support serves only a clean file, and only on a ticket assigned to this operator. */
export async function downloadTicketFile(ctx: FounderCallContext, attachmentId: string): Promise<FounderCallResult<FileDownload>> {
  return heldTo(await founderRecordCall(ctx, SUPPORT_DESK_ATTACHMENT_DOWNLOAD_OPS, { attachmentId }), (got) =>
    downloadServes(got, attachmentId),
  );
}

/**
 * Add a file for the ticket's owner, as the signed-in operator. svc-support takes the operator from the verified session,
 * requires the ticket to be assigned to them, scans the bytes and stores them only once clean.
 */
export async function uploadTicketFile(
  ctx: FounderCallContext,
  params: UploadParams,
  bytes: Uint8Array,
): Promise<FounderCallResult<TicketFile>> {
  const input = {
    ticketId: params.ticketId,
    clientRequestId: params.clientRequestId,
    contentType: params.contentType,
    bodyBase64: Buffer.from(bytes).toString('base64'),
  };
  // On the ticket it was added to, and added by an operator, not its owner.
  return heldTo(
    await founderRecordCall(ctx, SUPPORT_DESK_ATTACH_OPS, input),
    (file) => file.ticketId === params.ticketId && file.uploadedBy !== null,
  );
}
