/** Browser hop for the learner desk (J-academy-14). Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { LearnerDeskReply, LearnerView } from './learners-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function fetchLearner(userId: string): Promise<LearnerView | null> {
  try {
    const res = await fetch(`/api/academy-learners?userId=${encodeURIComponent(userId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.page) && isRecord(body.progress) && isRecord(body.card)
      ? (body as unknown as LearnerView)
      : null;
  } catch {
    return null;
  }
}

/** One change. A dropped connection is an unknown outcome: the page reads again and never repeats the change on its own. */
export async function postLearnerChange(body: Record<string, unknown>): Promise<LearnerDeskReply> {
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
    const res = await fetch('/api/academy-learners', {
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
    return unknown(`The console answered ${res.status} in a shape it does not recognise.`);
  } catch {
    return unknown('The connection dropped before an answer came back.');
  }
}

const unknown = (body: string): LearnerDeskReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'The page reads the learner again; check it before trying again.',
  code: null,
  changed: 'unknown',
});
