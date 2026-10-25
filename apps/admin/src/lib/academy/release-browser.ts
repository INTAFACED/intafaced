/** Browser hop for the release and pacing section. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { ReleaseDeskReply, ReleaseView } from './release-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function fetchRelease(courseId: string): Promise<ReleaseView | null> {
  try {
    const res = await fetch(`/api/academy-release?courseId=${encodeURIComponent(courseId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.release) ? (body as unknown as ReleaseView) : null;
  } catch {
    return null;
  }
}

const unknown = (body: string): ReleaseDeskReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the course again before trying again.',
  code: null,
  changed: 'unknown',
});

/** One change. A dropped connection is an unknown outcome: the section reads again and never repeats the change on its own. */
export async function postReleaseChange(body: Record<string, unknown>): Promise<ReleaseDeskReply> {
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
    const res = await fetch('/api/academy-release', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string' && isRecord(answer.release))
      return answer as unknown as ReleaseDeskReply;
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
