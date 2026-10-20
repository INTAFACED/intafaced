import type { ReadOutcome } from './types';

/**
 * What the browser gets back from the console's OWN server for an on-request read (a transfer record, the next page of a list).
 * `ok: false` carries what the server said, so the desk can tell an ended session from a bad id from a switched-off desk from a
 * server it could not reach, instead of calling all of them "could not reach".
 */
export type OwnFetch =
  | { readonly ok: true; readonly outcome: ReadOutcome }
  | { readonly ok: false; readonly status: number | null; readonly code: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isReadOutcome(body: unknown): body is ReadOutcome {
  return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.part) && (body.part.kind === 'ok' || body.part.kind === 'failed');
}

/** One GET to a same-origin desk route. Never throws. */
export async function fetchOutcome(url: string, signal?: AbortSignal): Promise<OwnFetch> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
  } catch {
    return { ok: false, status: null, code: null };
  }
  const body: unknown = await res.json().catch(() => null);
  if (
    res.ok &&
    isRecord(body) &&
    typeof body.asOf === 'string' &&
    isRecord(body.part) &&
    (body.part.kind === 'ok' || body.part.kind === 'failed')
  ) {
    return { ok: true, outcome: body as unknown as ReadOutcome };
  }
  const code =
    isRecord(body) && typeof body.error === 'string' ? body.error : isRecord(body) && typeof body.code === 'string' ? body.code : null;
  return { ok: false, status: res.ok ? null : res.status, code };
}

/** In words, for the founder, what a failed on-request read means. `what` is the thing being read. */
export function ownServerFailureText(failure: Extract<OwnFetch, { ok: false }>, what: 'transfer' | 'page' | 'customer'): string {
  const { status, code } = failure;
  if (status === 401) return 'Your founder session has ended; sign in again. Nothing was read.';
  if (status === 403) {
    return code === 'not_same_origin' || code === 'admin.session_origin'
      ? 'This request did not come from this console’s own page, so it was refused. Reload the desk and try again. Nothing was read.'
      : 'This founder session is no longer allowed to read this; sign in again. Nothing was read.';
  }
  if (status === 400) {
    if (what === 'customer') return 'That isn’t a customer account id (or coin) this desk can look up. Nothing was sent.';
    return what === 'transfer'
      ? 'That isn’t a transfer id this desk can look up. Nothing was sent.'
      : 'That isn’t a page marker this desk can read. Nothing was sent.';
  }
  if (status === 404) return 'This desk is switched off on this console. Nothing was read.';
  if (status !== null) return 'The console’s own server failed on this read. Nothing is shown rather than a guess.';
  return 'The console could not reach its own server for this. Nothing is shown rather than a guess.';
}
