/** Browser hop for a ticket's files. Same-origin BFF only; no credential is held here. */
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { uploadKey, type TicketFile } from './files';
import type { TicketFilesView } from './files-server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchTicketFiles(ticketId: string, signal?: AbortSignal): Promise<TicketFilesView | null> {
  try {
    const res = await fetch(`/api/support/attachments/files?id=${encodeURIComponent(ticketId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.files) ? (body as unknown as TicketFilesView) : null;
  } catch {
    return null;
  }
}

export type DownloadReply = { readonly ok: true; readonly blob: Blob } | { readonly ok: false; readonly refusal: RefusalView };

const UNKNOWN: DownloadReply = {
  ok: false,
  refusal: {
    title: 'The file was not downloaded',
    body: 'The console could not get that file.',
    next: 'Try again. Nothing was changed.',
    code: null,
    changed: 'no',
  },
};

/** The file as bytes, or the plain refusal svc-support gave. Only a binary answer is a file. */
export async function downloadFile(fileId: string): Promise<DownloadReply> {
  try {
    const res = await fetch(`/api/support/attachments/download?id=${encodeURIComponent(fileId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (res.ok && res.headers.get('content-type') === 'application/octet-stream') return { ok: true, blob: await res.blob() };
    const body: unknown = await res.json().catch(() => null);
    const r = isRecord(body) ? body.refusal : null;
    if (isRecord(r) && typeof r.title === 'string' && typeof r.body === 'string' && typeof r.next === 'string') {
      return {
        ok: false,
        refusal: { title: r.title, body: r.body, next: r.next, code: typeof r.code === 'string' ? r.code : null, changed: 'no' },
      };
    }
    return UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

export type UploadReply = { readonly ok: true; readonly file: TicketFile } | { readonly ok: false; readonly refusal: RefusalView };

const NOT_SENT: UploadReply = {
  ok: false,
  refusal: {
    title: 'Nothing was sent',
    body: 'Your founder session could not be confirmed.',
    next: 'Sign in again, then choose the file again.',
    code: null,
    changed: 'no',
  },
};

const UPLOAD_UNKNOWN: UploadReply = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console did not get an answer, so the file may or may not have been added.',
    next: 'Reload the files before choosing it again. Choosing the same file again cannot add it twice.',
    code: null,
    changed: 'unknown',
  },
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Adds one file to a ticket. The retry key is the ticket and the file's own digest, so sending the same file again after a
 * lost reply replays the first answer instead of adding a second copy.
 */
export async function uploadFile(ticketId: string, file: File): Promise<UploadReply> {
  let csrf: string | undefined;
  try {
    csrf = (await founderMutationHeaders())['x-intafaced-csrf'];
  } catch {
    return NOT_SENT;
  }
  if (!csrf) return NOT_SENT;
  try {
    const bytes = await file.arrayBuffer();
    const key = uploadKey(ticketId, await sha256Hex(bytes));
    const res = await fetch(`/api/support/attachments/upload?id=${encodeURIComponent(ticketId)}&key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': file.type, 'x-intafaced-csrf': csrf },
      body: bytes,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body: unknown = await res.json().catch(() => null);
    if (isRecord(body) && body.ok === true && isRecord(body.file)) return { ok: true, file: body.file as unknown as TicketFile };
    const r = isRecord(body) ? body.refusal : null;
    if (isRecord(r) && typeof r.title === 'string' && typeof r.body === 'string' && typeof r.next === 'string') {
      return {
        ok: false,
        refusal: {
          title: r.title,
          body: r.body,
          next: r.next,
          code: typeof r.code === 'string' ? r.code : null,
          changed: r.changed === 'unknown' ? 'unknown' : 'no',
        },
      };
    }
    return UPLOAD_UNKNOWN;
  } catch {
    return UPLOAD_UNKNOWN;
  }
}
