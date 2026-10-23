/** Browser hop for the incident desk. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import { publishApprovalOf, type IncidentDeskReply, type IncidentDeskView } from './incidents-model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchIncidentDesk(): Promise<IncidentDeskView | null> {
  try {
    const res = await fetch('/api/notify-incidents', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) &&
      typeof body.asOf === 'string' &&
      isRecord(body.notices) &&
      isRecord(body.postmortems) &&
      isRecord(body.approvals)
      ? (body as unknown as IncidentDeskView)
      : null;
  } catch {
    return null;
  }
}

const unknown = (body: string): IncidentDeskReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the desk again before trying again.',
  code: null,
  changed: 'unknown',
});

/** One change on the incident desk. */
export const postIncidentChange = (body: Record<string, unknown>) => postNotifyChange('/api/notify-incidents', body);

/**
 * One change through a notify desk's route. A dropped connection is an unknown outcome: the desk reads again, never
 * repeats the change with a new key.
 */
export async function postNotifyChange(
  path: '/api/notify-incidents' | '/api/notify-maintenance',
  body: Record<string, unknown>,
): Promise<IncidentDeskReply> {
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
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string') {
      const approval = publishApprovalOf(answer.approval);
      return approval ? { ok: true, what: answer.what, approval } : { ok: true, what: answer.what };
    }
    if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string' && typeof answer.next === 'string')
      return {
        ok: false,
        title: answer.title,
        body: answer.body,
        next: answer.next,
        code: typeof answer.code === 'string' ? answer.code : null,
        changed: answer.changed === 'unknown' ? 'unknown' : 'no',
      };
    return unknown('The console answered in a shape it does not understand.');
  } catch {
    return unknown('The connection ended before the console answered, so it is not known whether the change was made.');
  }
}
