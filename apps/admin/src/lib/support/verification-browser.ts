/** Browser hop for the balance disclosure gate. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import { readClaimReply } from './browser';
import type { SupportVerificationView, VerificationReply, VerificationRequest } from './verification';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const UNKNOWN: VerificationReply = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console could not tell whether that went through.',
    next: 'Read the checks again before doing anything twice.',
    code: null,
    changed: 'unknown',
  },
};

export async function fetchVerification(ticketId: string, signal?: AbortSignal): Promise<SupportVerificationView | null> {
  try {
    const res = await fetch(`/api/support/verification?id=${encodeURIComponent(ticketId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.checks) ? (body as unknown as SupportVerificationView) : null;
  } catch {
    return null;
  }
}

export function readVerificationReply(raw: unknown): VerificationReply {
  if (isRecord(raw) && raw.ok === true && typeof raw.summary === 'string') return { ok: true, summary: raw.summary };
  // A refusal is read by the desk's one strict reader; anything it does not know is "outcome not known".
  const read = readClaimReply(raw);
  return read.ok ? UNKNOWN : read;
}

/** Record a check or ask for a read behind the gate. Never throws: every outcome is a reply the panel can show. */
export async function postVerification(request: VerificationRequest): Promise<VerificationReply> {
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
    const res = await fetch('/api/support/verification', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readVerificationReply(await res.json().catch(() => null));
  } catch {
    return UNKNOWN;
  }
}
