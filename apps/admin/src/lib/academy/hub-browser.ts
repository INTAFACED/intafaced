/** Browser hop for the Learn hub desk. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { HubDeskReply, HubView } from './hub-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function fetchHub(): Promise<HubView | null> {
  try {
    const res = await fetch('/api/academy-hub', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.slot) && isRecord(body.topics)
      ? (body as unknown as HubView)
      : null;
  } catch {
    return null;
  }
}

/** One change. A dropped connection is an unknown outcome: the desk reads again and never repeats the change on its own. */
export async function postHubChange(body: Record<string, unknown>): Promise<HubDeskReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      title: 'You are signed out',
      body: error instanceof Error ? error.message : 'Your founder session is unavailable.',
      next: 'Sign in again. Nothing was changed.',
      code: null,
      changed: 'no',
    };
  }
  try {
    const res = await fetch('/api/academy-hub', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string') return { ok: true, what: answer.what };
    if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string' && typeof answer.next === 'string')
      return {
        ok: false,
        title: answer.title,
        body: answer.body,
        next: answer.next,
        code: typeof answer.code === 'string' ? answer.code : null,
        changed: answer.changed === 'unknown' ? 'unknown' : 'no',
      };
    return {
      ok: false,
      title: 'The outcome is not known',
      body: 'The console answered in a shape it does not understand.',
      next: 'Read the desk again before trying again.',
      code: null,
      changed: 'unknown',
    };
  } catch {
    return {
      ok: false,
      title: 'The outcome is not known',
      body: 'The connection ended before the console answered, so it is not known whether the change was made.',
      next: 'Read the desk again before trying again.',
      code: null,
      changed: 'unknown',
    };
  }
}
