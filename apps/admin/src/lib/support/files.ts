import type { SupportAttachment, SupportAttachmentScanState } from '@intafaced/contracts';

/**
 * The files on one ticket, as the operator desk shows them. Types only from the contracts package: a client component may
 * not pull its runtime into the browser bundle. A file is opened only when its scan state is `clean`.
 */

/** How many rows the list asks for. svc-support requires a page size; this is only the width of the list. */
export const FILES_PAGE = 100;

export type TicketFile = SupportAttachment;

export const SCAN_LABEL: Readonly<Record<SupportAttachmentScanState, string>> = {
  scanning: 'Being scanned',
  clean: 'Clean',
  blocked: 'Blocked',
};

export const SCAN_NOTE: Readonly<Record<SupportAttachmentScanState, string>> = {
  scanning: 'The scan has not finished. The file cannot be opened until it does.',
  clean: 'The scan passed. It can be downloaded.',
  blocked: 'The scan refused this file. It is kept out of every download.',
};

export const canOpen = (state: SupportAttachmentScanState): boolean => state === 'clean';

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isFileId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const STATES: readonly string[] = ['scanning', 'clean', 'blocked'];

/** Strict: a row with a missing, extra or mistyped key makes the whole list invalid, so a guess is never printed. */
export function readTicketFiles(raw: unknown): TicketFile[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TicketFile[] = [];
  for (const row of raw) {
    // `uploadedBy` is absent from a service that predates it, which reads as the owner's own upload.
    if (
      !isRecord(row) ||
      Object.keys(row)
        .filter((k) => k !== 'uploadedBy')
        .sort()
        .join(',') !== 'byteLength,contentType,createdAt,id,ownerId,scanState,ticketId'
    )
      return null;
    const { id, ticketId, ownerId, contentType, byteLength, scanState, createdAt } = row;
    const uploadedBy = row.uploadedBy ?? null;
    if (!isFileId(id) || !isFileId(ticketId) || !isFileId(ownerId)) return null;
    if (!(uploadedBy === null || isFileId(uploadedBy))) return null;
    if (typeof contentType !== 'string' || contentType === '') return null;
    if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 0) return null;
    if (typeof scanState !== 'string' || !STATES.includes(scanState)) return null;
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return null;
    out.push({ id, ticketId, ownerId, contentType, byteLength, scanState: scanState as SupportAttachmentScanState, uploadedBy, createdAt });
  }
  return out;
}

/** What the download route reads from svc-support: the bytes as base64 and the fixed content type. */
export interface FileDownload {
  readonly id: string;
  readonly byteLength: number;
  readonly bodyBase64: string;
}

export function readFileDownload(raw: unknown): FileDownload | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'bodyBase64,byteLength,contentType,disposition,id') return null;
  const { id, contentType, disposition, byteLength, bodyBase64 } = raw;
  if (!isFileId(id) || contentType !== 'application/octet-stream' || disposition !== 'attachment') return null;
  if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 0) return null;
  if (typeof bodyBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(bodyBase64)) return null;
  return { id, byteLength, bodyBase64 };
}
