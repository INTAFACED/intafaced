/** Browser hop for the OAuth apps desk. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { OAuthQueueView } from './server';
import type { OAuthReviewRequest, OAuthReviewStatus } from './model';

export type OAuthQueueDeskView = OAuthQueueView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchOAuthQueue(status: OAuthReviewStatus, signal?: AbortSignal): Promise<OAuthQueueDeskView | null> {
  try {
    const res = await fetch(`/api/identity-ops/oauth?status=${encodeURIComponent(status)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && body.status === status && isRecord(body.apps)
      ? (body as unknown as OAuthQueueDeskView)
      : null;
  } catch {
    return null;
  }
}

export type ReviewReply =
  { readonly ok: true; readonly appId: string; readonly status: OAuthReviewStatus } | { readonly ok: false; readonly refusal: RefusalView };

const UNKNOWN: Extract<ReviewReply, { ok: false }> = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console could not tell whether that went through.',
    next: 'Reload the queue to see where the app stands before deciding again.',
    code: null,
    changed: 'unknown',
  },
};

export function readReviewReply(raw: unknown): ReviewReply {
  if (!isRecord(raw)) return UNKNOWN;
  if (
    raw.ok === true &&
    typeof raw.appId === 'string' &&
    (raw.status === 'pending' || raw.status === 'approved' || raw.status === 'suspended')
  ) {
    return { ok: true, appId: raw.appId, status: raw.status };
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

export async function postReview(request: OAuthReviewRequest): Promise<ReviewReply> {
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
    const res = await fetch('/api/identity-ops/oauth', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'review', ...request }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readReviewReply(await res.json().catch(() => null));
  } catch {
    return UNKNOWN;
  }
}
