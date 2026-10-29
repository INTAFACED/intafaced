/** Browser hop for the campaigns desk. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { CampaignDeskReply, CampaignDetailView, CampaignsDeskView } from './builder-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function fetchCampaignsDesk(): Promise<CampaignsDeskView | null> {
  try {
    const res = await fetch('/api/more-ops/campaigns', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.campaigns) && isRecord(body.calendar)
      ? (body as unknown as CampaignsDeskView)
      : null;
  } catch {
    return null;
  }
}

export async function fetchCampaignDetail(id: string): Promise<CampaignDetailView | null> {
  try {
    const res = await fetch(`/api/more-ops/campaigns?id=${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.campaign) ? (body as unknown as CampaignDetailView) : null;
  } catch {
    return null;
  }
}

const unknown = (body: string): CampaignDeskReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the campaign again before trying again.',
  code: null,
  changed: 'unknown',
});

/** One change. A dropped connection is an unknown outcome: the desk reads again and never repeats the change on its own. */
export async function postCampaignChange(body: Record<string, unknown>): Promise<CampaignDeskReply> {
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
    const res = await fetch('/api/more-ops/campaigns', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string' && isRecord(answer.campaign))
      return answer as unknown as CampaignDeskReply;
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

export type RuleAnswer<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly title: string; readonly body: string; readonly next: string; readonly code: string | null };

const ruleUnknown = <T>(body: string): RuleAnswer<T> => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the library again before saving again.',
  code: null,
});

/** One rule call (try or save). A save whose reply is lost is an unknown outcome; the library is read again. */
export async function postRuleAction<T>(body: Record<string, unknown>): Promise<RuleAnswer<T>> {
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
    const res = await fetch('/api/more-ops/campaigns', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && 'data' in answer) return answer as unknown as RuleAnswer<T>;
    if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string' && typeof answer.next === 'string')
      return {
        ok: false,
        title: answer.title,
        body: answer.body,
        next: answer.next,
        code: typeof answer.code === 'string' ? answer.code : null,
      };
    return ruleUnknown('The console answered in a shape it does not understand.');
  } catch {
    return ruleUnknown('The connection ended before the console answered.');
  }
}

/** Every rule name's latest revision, or null when the library could not be read. */
export async function fetchRuleLibrary<T>(): Promise<RuleAnswer<T>> {
  try {
    const res = await fetch('/api/more-ops/campaigns?rules=library', { cache: 'no-store', credentials: 'same-origin' });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && 'data' in answer) return answer as unknown as RuleAnswer<T>;
    if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string')
      return {
        ok: false,
        title: answer.title,
        body: answer.body,
        next: String(answer.next ?? ''),
        code: typeof answer.code === 'string' ? answer.code : null,
      };
    return ruleUnknown('The console answered in a shape it does not understand.');
  } catch {
    return ruleUnknown('The rule library could not be read.');
  }
}
