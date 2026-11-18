/** Browser hop for the strategy library desk (J-algo-dev-10). Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import { isRecord } from '@intafaced/contracts/guards';
import { quantModerationEntrySchema, quantModerationQueueSchema } from '@intafaced/contracts/quant-library';
import type { LibraryDeskReply, LibraryDeskView } from './model';

const ENDPOINT = '/api/more-ops/library';

/** The desk's read, checked field by field: the queue against its contract, a failed part by its own fields. */
function readView(raw: unknown): LibraryDeskView | null {
  if (!isRecord(raw) || typeof raw.asOf !== 'string' || !isRecord(raw.queue)) return null;
  const q = raw.queue;
  if (q.kind === 'ok') {
    const data = quantModerationQueueSchema.safeParse(q.data);
    return data.success ? { asOf: raw.asOf, queue: { kind: 'ok', data: data.data } } : null;
  }
  if (q.kind !== 'failed' || typeof q.message !== 'string' || typeof q.notBuilt !== 'boolean' || typeof q.forbidden !== 'boolean')
    return null;
  const code = typeof q.code === 'string' ? q.code : null;
  return { asOf: raw.asOf, queue: { kind: 'failed', message: q.message, code, notBuilt: q.notBuilt, forbidden: q.forbidden } };
}

export async function fetchLibraryDesk(cursor: string | null = null): Promise<LibraryDeskView | null> {
  try {
    const url = cursor ? `${ENDPOINT}?cursor=${encodeURIComponent(cursor)}` : ENDPOINT;
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return readView(await res.json());
  } catch {
    return null;
  }
}

const unknown = (body: string): LibraryDeskReply => ({
  ok: false,
  title: 'The answer did not come back',
  body,
  next: 'Read the desk again before you try again: the change may or may not have been made.',
  code: null,
  changed: 'unknown',
});

/** One action. A dropped connection is an unknown outcome: the desk reads again and never repeats it with a new key. */
export async function postLibraryAction(body: Record<string, unknown>): Promise<LibraryDeskReply> {
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
      const entry = quantModerationEntrySchema.safeParse(answer.entry);
      if (entry.success) return { ok: true, what: answer.what, entry: entry.data };
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
