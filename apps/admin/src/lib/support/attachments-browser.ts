/** Browser hop for the support attachment limits. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { readAttachmentLimits, type AttachmentLimits, type AttachmentSetRequest } from './attachments';
import type { SupportAttachmentsView } from './attachments-server';

export type AttachmentsDeskView = SupportAttachmentsView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchAttachments(signal?: AbortSignal): Promise<AttachmentsDeskView | null> {
  try {
    const res = await fetch('/api/support/attachments', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.status) ? (body as unknown as AttachmentsDeskView) : null;
  } catch {
    return null;
  }
}

export type AttachmentsReply =
  { readonly ok: true; readonly limits: AttachmentLimits } | { readonly ok: false; readonly refusal: RefusalView };

const UNKNOWN: Extract<AttachmentsReply, { ok: false }> = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console could not tell whether that went through.',
    next: 'Reload the details to see what is stored before changing them again.',
    code: null,
    changed: 'unknown',
  },
};

export function readAttachmentsReply(raw: unknown): AttachmentsReply {
  if (!isRecord(raw)) return UNKNOWN;
  if (raw.ok === true) {
    const limits = readAttachmentLimits(raw.limits);
    return limits ? { ok: true, limits } : UNKNOWN;
  }
  const r = raw.refusal;
  if (
    raw.ok === false &&
    isRecord(r) &&
    typeof r.title === 'string' &&
    typeof r.body === 'string' &&
    typeof r.next === 'string' &&
    (r.changed === 'no' || r.changed === 'unknown')
  ) {
    return {
      ok: false,
      refusal: { title: r.title, body: r.body, next: r.next, code: typeof r.code === 'string' ? r.code : null, changed: r.changed },
    };
  }
  return UNKNOWN;
}

export async function postAttachments(request: AttachmentSetRequest): Promise<AttachmentsReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      refusal: {
        title: 'Nothing was sent',
        body: error instanceof Error ? error.message : 'Your founder session could not be confirmed.',
        next: 'Sign in again, then repeat the step.',
        code: null,
        changed: 'no',
      },
    };
  }
  try {
    const res = await fetch('/api/support/attachments', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readAttachmentsReply(await res.json().catch(() => null));
  } catch {
    return UNKNOWN;
  }
}
