/** Browser hop for the moderation and course team desks (J-academy-18). Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { ModerationView, TeamDeskReply, TeamView } from './team-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const query = (courseId: string | null) => (courseId ? `?courseId=${encodeURIComponent(courseId)}` : '');

async function read<T>(url: string, ok: (body: Record<string, unknown>) => boolean): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && ok(body) ? (body as unknown as T) : null;
  } catch {
    return null;
  }
}

export const fetchModeration = (courseId: string | null) =>
  read<ModerationView>(`/api/academy-moderation${query(courseId)}`, (b) => typeof b.asOf === 'string' && isRecord(b.queue));

export const fetchTeam = (courseId: string | null) =>
  read<TeamView>(`/api/academy-team${query(courseId)}`, (b) => typeof b.asOf === 'string' && isRecord(b.team) && isRecord(b.roles));

const unknown = (body: string): TeamDeskReply => ({
  ok: false,
  title: 'The answer did not come back',
  body,
  next: 'Read the desk again before you try again: the change may or may not have been made.',
  code: null,
  changed: 'unknown',
});

/** One change. A dropped connection is an unknown outcome: the desk reads again and never repeats the change on its own. */
export async function postTeamChange(
  url: '/api/academy-moderation' | '/api/academy-team',
  body: Record<string, unknown>,
): Promise<TeamDeskReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      title: 'You are signed out',
      body: error instanceof Error ? error.message : 'Your console session is unavailable.',
      next: 'Sign in again. Nothing was changed.',
      code: null,
      changed: 'no',
    };
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
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
    return unknown(`The console answered ${res.status} in a shape it does not recognise.`);
  } catch {
    return unknown('The connection dropped before an answer came back.');
  }
}
