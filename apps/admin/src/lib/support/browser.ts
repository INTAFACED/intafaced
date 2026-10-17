/** Browser hop for the support desk. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { SupportQueueView, SupportTicketView } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchQueue(signal?: AbortSignal): Promise<SupportQueueView | null> {
  try {
    const res = await fetch('/api/support', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.queue) ? (body as unknown as SupportQueueView) : null;
  } catch {
    return null;
  }
}

export async function fetchTicket(id: string, signal?: AbortSignal): Promise<SupportTicketView | null> {
  try {
    const res = await fetch(`/api/support?view=ticket&id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.detail) ? (body as unknown as SupportTicketView) : null;
  } catch {
    return null;
  }
}

export type ClaimReply =
  | { readonly ok: true; readonly ticketId: string; readonly assigneeId: string | null; readonly status: string }
  | { readonly ok: false; readonly refusal: RefusalView };

const UNKNOWN: ClaimReply = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console could not tell whether the claim went through.',
    next: 'Open the ticket again to see who owns it before doing anything else.',
    code: null,
    changed: 'unknown',
  },
};

export function readClaimReply(raw: unknown): ClaimReply {
  if (!isRecord(raw)) return UNKNOWN;
  if (
    raw.ok === true &&
    typeof raw.ticketId === 'string' &&
    typeof raw.status === 'string' &&
    (raw.assigneeId === null || typeof raw.assigneeId === 'string')
  ) {
    return { ok: true, ticketId: raw.ticketId, assigneeId: raw.assigneeId, status: raw.status };
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

export async function postClaim(ticketId: string): Promise<ClaimReply> {
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
    const res = await fetch('/api/support', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'claim', ticketId }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readClaimReply(await res.json().catch(() => null));
  } catch {
    return UNKNOWN;
  }
}
