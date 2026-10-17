/** Browser hop for the live compliance section. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { ComplianceRead, Disposition } from './model';

export type DisposeReply =
  { readonly ok: true; readonly itemId: string; readonly status: Disposition } | { readonly ok: false; readonly refusal: RefusalView };

const UNKNOWN: DisposeReply = {
  ok: false,
  refusal: {
    title: 'The console got an answer it could not read',
    body: 'It is not known whether the case was dispositioned.',
    next: 'Read the queue again before doing anything else.',
    code: null,
    changed: 'unknown',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function readDisposeReply(raw: unknown): DisposeReply {
  if (!isRecord(raw)) return UNKNOWN;
  if (raw.ok === true && typeof raw.itemId === 'string' && (raw.status === 'cleared' || raw.status === 'rejected')) {
    return { ok: true, itemId: raw.itemId, status: raw.status };
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

export async function fetchCompliance(signal?: AbortSignal): Promise<ComplianceRead | null> {
  try {
    const res = await fetch('/api/compliance', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.status) && isRecord(body.queue)
      ? (body as unknown as ComplianceRead)
      : null;
  } catch {
    return null;
  }
}

export async function postDisposition(input: {
  itemId: string;
  status: Disposition;
  reason: string;
  confirm: string;
}): Promise<DisposeReply> {
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
    const res = await fetch('/api/compliance', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'dispose', ...input }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readDisposeReply(await res.json().catch(() => null));
  } catch {
    return {
      ok: false,
      refusal: {
        title: 'The outcome is not known',
        body: 'The connection ended before the console answered, so it is not known whether the case was dispositioned.',
        next: 'Read the queue again before doing anything else.',
        code: null,
        changed: 'unknown',
      },
    };
  }
}
