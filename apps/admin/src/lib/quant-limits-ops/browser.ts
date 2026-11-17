/** Browser hop for the plan limits desk (J-algo-dev-12). Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import { isRecord } from '@intafaced/contracts/guards';
import { quantEscapeCorpusSchema, quantQuotaProfileSchema } from '@intafaced/contracts/quant-algo';
import type { LimitsDeskReply, LimitsDeskView } from './model';

const ENDPOINT = '/api/more-ops/quant-limits';

/** The desk's read, checked field by field: the profile against its contract, a failed part by its own fields. */
function readView(raw: unknown): LimitsDeskView | null {
  if (!isRecord(raw) || typeof raw.asOf !== 'string' || !isRecord(raw.profile)) return null;
  const p = raw.profile;
  if (p.kind === 'ok') {
    const data = quantQuotaProfileSchema.safeParse(p.data);
    return data.success ? { asOf: raw.asOf, profile: { kind: 'ok', data: data.data } } : null;
  }
  if (p.kind !== 'failed' || typeof p.message !== 'string' || typeof p.notBuilt !== 'boolean' || typeof p.forbidden !== 'boolean')
    return null;
  const code = typeof p.code === 'string' ? p.code : null;
  return { asOf: raw.asOf, profile: { kind: 'failed', message: p.message, code, notBuilt: p.notBuilt, forbidden: p.forbidden } };
}

export async function fetchLimitsDesk(profile: string): Promise<LimitsDeskView | null> {
  try {
    const res = await fetch(`${ENDPOINT}?profile=${encodeURIComponent(profile)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return readView(await res.json());
  } catch {
    return null;
  }
}

const unknown = (body: string): LimitsDeskReply => ({
  ok: false,
  title: 'The answer did not come back',
  body,
  next: 'Read the plan again before you try again: the change may or may not have been made.',
  code: null,
  changed: 'unknown',
});

/** One action. A dropped connection is an unknown outcome: the desk reads again and a retry reuses the same key. */
export async function postLimitsAction(body: Record<string, unknown>): Promise<LimitsDeskReply> {
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
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string') {
      if (answer.corpus === null) return { ok: true, what: answer.what, corpus: null };
      const corpus = quantEscapeCorpusSchema.safeParse(answer.corpus);
      if (corpus.success) return { ok: true, what: answer.what, corpus: corpus.data };
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
    return unknown(`The console answered ${res.status} in a shape it does not recognise.`);
  } catch {
    return unknown('The connection dropped before an answer came back.');
  }
}
