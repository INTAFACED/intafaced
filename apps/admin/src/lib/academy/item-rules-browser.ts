/** Browser hop for the prerequisites and due dates section. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { ItemRulesDeskReply, ItemRulesView } from './item-rules-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function fetchItemRules(courseId: string): Promise<ItemRulesView | null> {
  try {
    const res = await fetch(`/api/academy-item-rules?courseId=${encodeURIComponent(courseId)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.rules) ? (body as unknown as ItemRulesView) : null;
  } catch {
    return null;
  }
}

const unknown = (body: string): ItemRulesDeskReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the course again before trying again.',
  code: null,
  changed: 'unknown',
});

/** One change. A dropped connection is an unknown outcome: the section reads again and never repeats the change on its own. */
export async function postItemRulesChange(body: Record<string, unknown>): Promise<ItemRulesDeskReply> {
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
    const res = await fetch('/api/academy-item-rules', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string' && isRecord(answer.rules))
      return answer as unknown as ItemRulesDeskReply;
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
