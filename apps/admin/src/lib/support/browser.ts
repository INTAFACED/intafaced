/** Browser hop for the support desk. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { SupportActionRequest } from './model';
import type {
  SupportKbView,
  SupportPropertiesView,
  SupportQueueView,
  SupportStaffView,
  SupportTicketView,
  TicketExtrasView,
} from './types';

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

const UNKNOWN: Extract<ClaimReply, { ok: false }> = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console could not tell whether that went through.',
    next: 'Read the ticket (or the articles) again to see where it stands before doing anything twice.',
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

export async function fetchTicketExtras(id: string, signal?: AbortSignal): Promise<TicketExtrasView | null> {
  try {
    const res = await fetch(`/api/support?view=extras&id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.caseFile) && isRecord(body.rating)
      ? (body as unknown as TicketExtrasView)
      : null;
  } catch {
    return null;
  }
}

export async function fetchTicketProperties(id: string, signal?: AbortSignal): Promise<SupportPropertiesView | null> {
  try {
    const res = await fetch(`/api/support?view=properties&id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.properties) ? (body as unknown as SupportPropertiesView) : null;
  } catch {
    return null;
  }
}

export async function fetchStaff(signal?: AbortSignal): Promise<SupportStaffView | null> {
  try {
    const res = await fetch('/api/support?view=staff', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) &&
      typeof body.asOf === 'string' &&
      typeof body.meId === 'string' &&
      isRecord(body.roster) &&
      isRecord(body.policy)
      ? (body as unknown as SupportStaffView)
      : null;
  } catch {
    return null;
  }
}

export async function fetchKb(signal?: AbortSignal): Promise<SupportKbView | null> {
  try {
    const res = await fetch('/api/support?view=kb', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.articles) ? (body as unknown as SupportKbView) : null;
  } catch {
    return null;
  }
}

export type ActionReply =
  | { readonly ok: true; readonly action: SupportActionRequest['action']; readonly summary: string }
  | { readonly ok: false; readonly refusal: RefusalView };

const ACTIONS: readonly string[] = ['reply', 'status', 'escalate', 'properties', 'staff_availability', 'kb_publish', 'kb_unpublish'];

/** Strict reader: anything that is not exactly a known answer is "outcome not known", never a success. */
export function readActionReply(raw: unknown): ActionReply {
  if (
    isRecord(raw) &&
    raw.ok === true &&
    typeof raw.action === 'string' &&
    ACTIONS.includes(raw.action) &&
    typeof raw.summary === 'string'
  ) {
    return { ok: true, action: raw.action as SupportActionRequest['action'], summary: raw.summary };
  }
  const read = readClaimReply(raw);
  return read.ok ? UNKNOWN : read;
}

function nothingSent(body: string): ActionReply {
  return {
    ok: false,
    refusal: { title: 'Nothing was sent', body, next: 'Sign in again, then repeat the step.', code: null, changed: 'no' },
  };
}

/** Send one desk write through the console's own server. Never throws: every outcome is a reply the page can show. */
export async function postSupportAction(request: SupportActionRequest): Promise<ActionReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return nothingSent(error instanceof Error ? error.message : 'Your founder session could not be confirmed.');
  }
  try {
    const res = await fetch('/api/support', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readActionReply(await res.json().catch(() => null));
  } catch {
    return UNKNOWN;
  }
}
