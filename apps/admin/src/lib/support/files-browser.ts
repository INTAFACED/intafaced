/** Browser hop for a ticket's files. Same-origin BFF only; no credential is held here. */
import type { RefusalView } from '@/lib/desk/refusal-copy';
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
