/** Browser hop for the status page desk. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { StatusDeskReply, StatusDeskView } from './status-model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchStatusDesk(signal?: AbortSignal): Promise<StatusDeskView | null> {
  try {
    const res = await fetch('/api/notify-status', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.definition) && isRecord(body.page)
      ? (body as unknown as StatusDeskView)
      : null;
  } catch {
    return null;
  }
}

const fail = (title: string, body: string, next: string, changed: 'no' | 'unknown'): StatusDeskReply => ({
  ok: false,
  title,
  body,
  next,
  changed,
});

/** One change. A dropped connection is an unknown outcome: the desk reads the page again, never repeats the change. */
export async function postStatusChange(body: Record<string, unknown>): Promise<StatusDeskReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return fail(
      'You are signed out',
      error instanceof Error ? error.message : 'Your founder session is unavailable.',
      'Sign in again. Nothing was changed.',
      'no',
    );
  }
  try {
    const res = await fetch('/api/notify-status', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && (answer.what === 'configured' || answer.what === 'recorded'))
      return { ok: true, what: answer.what };
    if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string' && typeof answer.next === 'string')
      return fail(answer.title, answer.body, answer.next, answer.changed === 'unknown' ? 'unknown' : 'no');
    return fail(
      'The outcome is not known',
      'The console answered in a shape it does not understand.',
      'Read the page again first.',
      'unknown',
    );
  } catch {
    return fail(
      'The outcome is not known',
      'The connection ended before the console answered, so it is not known whether the change was made.',
      'Read the page again before trying again.',
      'unknown',
    );
  }
}
