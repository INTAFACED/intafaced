/** Browser hop for the support desk. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { SupportMergePreview } from '@intafaced/contracts';
import { supportMacroAppliedSchema, type SupportMacroApplied } from '@intafaced/contracts/support-macros';
import { readMergePreview } from './merge';
import type { SupportActionRequest } from './model';
import { EMPTY_QUERY, queueQueryString, type QueueQuery } from './queue-query';
import type {
  SupportKbView,
  SupportLifecycleView,
  SupportMacrosView,
  SupportCustomerView,
  SupportChartsLookupView,
  SupportPropertiesView,
  SupportRatingSummaryView,
  SupportQueueView,
  SupportGroupsView,
  SupportGroupLogView,
  SupportRoutingWaitingView,
  SupportStaffView,
  SupportTicketRoutingView,
  SupportTicketView,
  SupportViewsView,
  TicketExtrasView,
} from './types';
import { isRecord } from '@intafaced/contracts/guards';

export async function fetchQueue(query: QueueQuery = EMPTY_QUERY, signal?: AbortSignal): Promise<SupportQueueView | null> {
  // `view` names the part of the desk asked for here, so a saved view's id travels as `savedView`.
  const params = new URLSearchParams(queueQueryString(query));
  const saved = params.get('view');
  params.delete('view');
  if (saved) params.set('savedView', saved);
  const search = params.toString();
  try {
    const res = await fetch(search ? `/api/support?${search}` : '/api/support', {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportQueueView>(body, ['queue']) ? body : null;
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
    return isView<SupportTicketView>(body, ['detail']) ? body : null;
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
    return isView<TicketExtrasView>(body, ['caseFile', 'rating']) ? body : null;
  } catch {
    return null;
  }
}

/** The card when the console refused the read itself: unread, with the console's code. */
export function consoleRefusedCard(status: number, code: string | null, now: Date = new Date()): SupportCustomerView {
  const refused = {
    kind: 'failed',
    code,
    notBuilt: false,
    forbidden: status === 401 || status === 403,
  } as const;
  return {
    asOf: now.toISOString(),
    account: { ...refused, message: `The console could not read the account (HTTP ${String(status)}).` },
    orders: { ...refused, message: `The console could not read the related orders (HTTP ${String(status)}).` },
  };
}

export async function fetchCustomerCard(id: string, signal?: AbortSignal): Promise<SupportCustomerView | null> {
  try {
    const res = await fetch(`/api/support?view=customer&id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    // The console's own refusal (its founder check asks svc-identity first) keeps its code, so the card names why it is unread.
    if (!res.ok) return consoleRefusedCard(res.status, isRecord(body) && typeof body.code === 'string' ? body.code : null);
    return isView<SupportCustomerView>(body, ['account', 'orders']) ? body : null;
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
    return isView<SupportPropertiesView>(body, ['properties']) ? body : null;
  } catch {
    return null;
  }
}

export async function fetchTicketLifecycle(id: string, signal?: AbortSignal): Promise<SupportLifecycleView | null> {
  try {
    const res = await fetch(`/api/support?view=lifecycle&id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportLifecycleView>(body, ['lifecycle']) ? body : null;
  } catch {
    return null;
  }
}

export async function fetchRatingSummary(
  window: { from: string; to: string },
  signal?: AbortSignal,
): Promise<SupportRatingSummaryView | null> {
  try {
    const res = await fetch(`/api/support?view=ratings&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportRatingSummaryView>(body, ['summary']) ? body : null;
  } catch {
    return null;
  }
}

export async function fetchStaff(signal?: AbortSignal): Promise<SupportStaffView | null> {
  try {
    const res = await fetch('/api/support?view=staff', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportStaffView>(body, ['roster', 'policy', 'routing', 'log']) && typeof body.meId === 'string' ? body : null;
  } catch {
    return null;
  }
}

export async function fetchGroups(signal?: AbortSignal): Promise<SupportGroupsView | null> {
  try {
    const res = await fetch('/api/support?view=groups', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportGroupsView>(body, ['groups', 'scope', 'roster', 'routing']) && typeof body.meId === 'string' ? body : null;
  } catch {
    return null;
  }
}

/** The console route's answer has the view's outer shape: `asOf` and each named part; the route built the rest from the parsed service answer. */
function isView<T>(body: unknown, parts: readonly string[]): body is T {
  return isRecord(body) && typeof body.asOf === 'string' && parts.every((k) => isRecord(body[k]));
}

async function readView(path: string, signal: AbortSignal | undefined, has: readonly string[]): Promise<unknown> {
  try {
    const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<unknown>(body, has) ? body : null;
  } catch {
    return null;
  }
}

export async function fetchGroupLog(groupId: string, signal?: AbortSignal): Promise<SupportGroupLogView | null> {
  const body = await readView(`/api/support?view=group_log&id=${encodeURIComponent(groupId)}`, signal, ['log']);
  return body && (body as { groupId?: unknown }).groupId === groupId ? (body as SupportGroupLogView) : null;
}

export async function fetchRoutingWaiting(signal?: AbortSignal): Promise<SupportRoutingWaitingView | null> {
  return (await readView('/api/support?view=routing_waiting', signal, ['waiting'])) as SupportRoutingWaitingView | null;
}

export async function fetchTicketRouting(ticketId: string, signal?: AbortSignal): Promise<SupportTicketRoutingView | null> {
  const body = await readView(`/api/support?view=ticket_routing&id=${encodeURIComponent(ticketId)}`, signal, ['routing', 'roster']);
  return body && typeof (body as { meId?: unknown }).meId === 'string' ? (body as SupportTicketRoutingView) : null;
}

export async function fetchViews(signal?: AbortSignal): Promise<SupportViewsView | null> {
  try {
    const res = await fetch('/api/support?view=views', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportViewsView>(body, ['list', 'counts']) ? body : null;
  } catch {
    return null;
  }
}

export async function fetchKb(signal?: AbortSignal): Promise<SupportKbView | null> {
  try {
    const res = await fetch('/api/support?view=kb', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportKbView>(body, ['articles']) ? body : null;
  } catch {
    return null;
  }
}

export type ActionReply =
  | { readonly ok: true; readonly action: SupportActionRequest['action']; readonly summary: string }
  | { readonly ok: false; readonly refusal: RefusalView };

const ACTIONS: readonly string[] = [
  'reply',
  'note',
  'bulk',
  'merge',
  'status',
  'escalate',
  'properties',
  'staff_availability',
  'group_save',
  'group_member',
  'routing_mode',
  'staff_routing',
  'ticket_skill',
  'kb_publish',
  'kb_unpublish',
  'kb_audience',
  'view_save',
  'unclaim',
  'assign',
  'signature_set',
];

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

/** Claim whichever open request the queue ranks first. The answer names the request so the page can open it. */
export async function postClaimNext(): Promise<ClaimReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    const sent = nothingSent(error instanceof Error ? error.message : 'Your founder session could not be confirmed.');
    return sent.ok ? UNKNOWN : sent;
  }
  try {
    const res = await fetch('/api/support', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'claim_next' }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readClaimReply(await res.json().catch(() => null));
  } catch {
    return UNKNOWN;
  }
}

/** What a merge would do, read before the confirmation. Null when it could not be read: never drawn as "nothing moves". */
export async function fetchMergePreview(sourceId: string, survivorId: string, signal?: AbortSignal): Promise<MergePreviewReply> {
  try {
    const res = await fetch(`/api/support?view=merge&id=${encodeURIComponent(sourceId)}&survivor=${encodeURIComponent(survivorId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const preview = readMergePreview(isRecord(body) ? body.preview : null);
      return preview ? { ok: true, preview } : { ok: false, refusal: null };
    }
    const read = readClaimReply(body);
    return { ok: false, refusal: read.ok ? null : read.refusal };
  } catch {
    return { ok: false, refusal: null };
  }
}

export type MergePreviewReply =
  { readonly ok: true; readonly preview: SupportMergePreview } | { readonly ok: false; readonly refusal: RefusalView | null };

/** The desk's macros and the agent's own signature. Null when they could not be read: never drawn as "no macros". */
export async function fetchMacros(signal?: AbortSignal): Promise<SupportMacrosView | null> {
  try {
    const res = await fetch('/api/support?view=macros', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isView<SupportMacrosView>(body, ['macros', 'signature']) ? body : null;
  } catch {
    return null;
  }
}

export type MacroApplyReply =
  { readonly ok: true; readonly applied: SupportMacroApplied } | { readonly ok: false; readonly refusal: RefusalView | null };

/** One macro filled from one request. svc-support writes nothing: the text only goes into the agent's draft. */
export async function fetchMacroApply(ticketId: string, macroId: string): Promise<MacroApplyReply> {
  try {
    const res = await fetch(`/api/support?view=macro&id=${encodeURIComponent(ticketId)}&macro=${encodeURIComponent(macroId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body: unknown = await res.json().catch(() => null);
    const applied = res.ok && isRecord(body) && body.ok === true ? supportMacroAppliedSchema.safeParse(body.applied) : null;
    if (applied?.success) return { ok: true, applied: applied.data };
    const read = readClaimReply(body);
    return { ok: false, refusal: read.ok ? null : read.refusal };
  } catch {
    return { ok: false, refusal: null };
  }
}

/**
 * One charts lookup on a ticket (J-charts-desk-19 #1). Each call writes an audit row on the request, so it runs only when
 * the agent asks. Null when nothing readable came back; the console's own refusal keeps its code.
 */
/** The console route's answer has the view's outer shape; the route itself built it from the parsed service answer. */
function isChartsLookupView(body: unknown): body is SupportChartsLookupView {
  return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.lookup) && typeof body.lookup.kind === 'string';
}

export async function fetchChartsLookup(id: string): Promise<SupportChartsLookupView | null> {
  try {
    const res = await fetch(`/api/support?view=charts&id=${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : null;
      return {
        asOf: new Date().toISOString(),
        lookup: {
          kind: 'failed',
          message: `The console could not run the lookup (HTTP ${String(res.status)}).`,
          code,
          notBuilt: false,
          forbidden: res.status === 401 || res.status === 403,
        },
      };
    }
    return isChartsLookupView(body) ? body : null;
  } catch {
    return null;
  }
}
