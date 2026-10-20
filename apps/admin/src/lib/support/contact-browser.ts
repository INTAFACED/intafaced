/** Browser hop for the support contact settings. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { readContactChannels, type ContactChannels, type ContactSetRequest } from './contact';
import type { SupportContactView } from './contact-server';

export type ContactDeskView = SupportContactView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchContact(signal?: AbortSignal): Promise<ContactDeskView | null> {
  try {
    const res = await fetch('/api/support/contact', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.contact) ? (body as unknown as ContactDeskView) : null;
  } catch {
    return null;
  }
}

export type ContactReply = { readonly ok: true; readonly contact: ContactChannels } | { readonly ok: false; readonly refusal: RefusalView };

const UNKNOWN: Extract<ContactReply, { ok: false }> = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console could not tell whether that went through.',
    next: 'Reload the details to see what is stored before changing them again.',
    code: null,
    changed: 'unknown',
  },
};

export function readContactReply(raw: unknown): ContactReply {
  if (!isRecord(raw)) return UNKNOWN;
  if (raw.ok === true) {
    const contact = readContactChannels(raw.contact);
    return contact ? { ok: true, contact } : UNKNOWN;
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

export async function postContact(request: ContactSetRequest): Promise<ContactReply> {
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
    const res = await fetch('/api/support/contact', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readContactReply(await res.json().catch(() => null));
  } catch {
    return UNKNOWN;
  }
}
