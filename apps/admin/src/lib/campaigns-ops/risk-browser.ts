/** Browser hop for the campaign risk review desk (J-campaigns-18). Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RuleAnswer } from './builder-browser';
import { isRecord } from '@intafaced/contracts/guards';

const URL_ = '/api/more-ops/campaigns/risk';

function answerOf<T>(answer: unknown, unknown: string): RuleAnswer<T> {
  // The console's own route shaped it from the service's schema-checked answer (risk-server.ts).
  if (isRecord(answer) && answer.ok === true && 'data' in answer) return { ok: true, data: answer.data as T };
  if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string')
    return {
      ok: false,
      title: answer.title,
      body: answer.body,
      next: String(answer.next ?? ''),
      code: typeof answer.code === 'string' ? answer.code : null,
    };
  return { ok: false, title: 'The outcome is not known', body: unknown, next: 'Read the desk again before trying again.', code: null };
}

export async function riskRead<T>(query: string): Promise<RuleAnswer<T>> {
  try {
    const res = await fetch(`${URL_}${query}`, { cache: 'no-store', credentials: 'same-origin' });
    return answerOf<T>(await res.json().catch(() => null), 'The console answered in a shape it does not understand.');
  } catch {
    return answerOf<T>(null, 'svc-campaigns could not be read.');
  }
}

/** One change. A dropped connection is an unknown outcome: the desk reads again and never repeats the change on its own. */
export async function riskChange<T>(body: Record<string, unknown>): Promise<RuleAnswer<T>> {
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
    };
  }
  try {
    const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
    return answerOf<T>(await res.json().catch(() => null), 'The console answered in a shape it does not understand.');
  } catch {
    return answerOf<T>(null, 'The connection ended before the console answered, so it is not known whether the change was made.');
  }
}
