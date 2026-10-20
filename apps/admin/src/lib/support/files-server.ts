import 'server-only';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { FILES_PAGE, readFileDownload, readTicketFiles, type FileDownload, type TicketFile } from './files';

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
export function downloadTicketFile(ctx: FounderCallContext, attachmentId: string): Promise<FounderCallResult<FileDownload>> {
  return founderCall(ctx, 'support', 'attachmentDownloadOps', 'GET', { attachmentId }, (raw) => {
    const got = readFileDownload(raw);
    return got && got.id === attachmentId ? got : null;
  });
}
