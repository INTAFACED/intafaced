/** Browser hops for the announcement desk and the preferences page. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { Preferences } from '@intafaced/contracts/ops-console-preferences';
import type { AnnouncementsView, OpsRead } from './model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchAnnouncements(): Promise<AnnouncementsView | null> {
  try {
    const res = await fetch('/api/console-announcements', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && isRecord(body.view) && typeof body.view.kind === 'string' ? (body.view as unknown as AnnouncementsView) : null;
  } catch {
    return null;
  }
}

export async function fetchPreferences(): Promise<OpsRead<Preferences> | null> {
  try {
    const res = await fetch('/api/console-preferences', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && isRecord(body.view) && typeof body.view.kind === 'string'
      ? (body.view as unknown as OpsRead<Preferences>)
      : null;
  } catch {
    return null;
  }
}

export type ConsoleChangeReply =
  | { readonly ok: true; readonly answer: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

const unknown = (body: string): ConsoleChangeReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the page again before trying again.',
  code: null,
  changed: 'unknown',
});

/**
 * One change through a console route. A dropped connection is an unknown outcome: the page reads again, never repeats the
 * change with a new key.
 */
export async function postConsoleChange(
  path: '/api/console-announcements' | '/api/console-preferences',
  body: Record<string, unknown>,
): Promise<ConsoleChangeReply> {
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
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true) return { ok: true, answer };
    if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string' && typeof answer.next === 'string')
      return {
        ok: false,
        title: answer.title,
        body: answer.body,
        next: answer.next,
        code: typeof answer.code === 'string' ? answer.code : null,
        changed: answer.changed === 'unknown' ? 'unknown' : 'no',
      };
    // Maintenance mode holds the write at the gate (`{ code: 'ops.console_read_only' }`, 423): a definite "not sent".
    if (res.status === 423 && isRecord(answer) && typeof answer.code === 'string')
      return { ok: false, ...explainRefusal(answer.code, 423, false) };
    return unknown('The console answered in a shape it does not understand.');
  } catch {
    return unknown('The connection ended before the console answered, so it is not known whether the change was made.');
  }
}
