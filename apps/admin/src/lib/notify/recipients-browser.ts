/** Browser hop for the recipient health panel. Same-origin BFF only; the CSRF nonce is fetched per release. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RecipientState, RecipientsView, ReleaseReply, RecipientRow } from './recipients-model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchRecipients(state: RecipientState, signal?: AbortSignal): Promise<RecipientsView | null> {
  try {
    const res = await fetch(`/api/notify-recipients?state=${state}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && (body.kind === 'ok' || body.kind === 'failed') ? (body as unknown as RecipientsView) : null;
  } catch {
    return null;
  }
}

const fail = (title: string, body: string, next: string, changed: 'no' | 'unknown'): ReleaseReply => ({
  ok: false,
  title,
  body,
  next,
  changed,
});

export async function postRelease(
  row: Pick<RecipientRow, 'userId' | 'channel' | 'quarantinedAt'>,
  reason: string,
  signal?: AbortSignal,
): Promise<ReleaseReply> {
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
    const res = await fetch('/api/notify-recipients', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: row.userId, channel: row.channel, quarantinedAt: row.quarantinedAt, reason }),
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    if (isRecord(body) && body.ok === true && typeof body.replayed === 'boolean') return { ok: true, replayed: body.replayed };
    if (isRecord(body) && typeof body.title === 'string' && typeof body.body === 'string' && typeof body.next === 'string')
      return fail(body.title, body.body, body.next, body.changed === 'unknown' ? 'unknown' : 'no');
    if (res.status === 401 || res.status === 403)
      return fail(
        'You are signed out',
        'The console did not accept your founder session for this action.',
        'Sign out and in again. Nothing was changed.',
        'no',
      );
    return fail(
      'The outcome is not known',
      'The console answered in a shape it does not understand.',
      'Read the list again before trying again.',
      'unknown',
    );
  } catch {
    return fail(
      'The outcome is not known',
      'The connection ended before the console answered, so it is not known whether the address was released.',
      'Read the list again before trying again.',
      'unknown',
    );
  }
}
