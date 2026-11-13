/** Browser hop for certificate designs and the issued list. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { CertDeskReply, CertDesignsView, IssuedCertsView } from './cert-designs-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

async function read<T>(query: string, ok: (body: Record<string, unknown>) => boolean): Promise<T | null> {
  try {
    const res = await fetch(`/api/academy-cert-designs?${query}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && ok(body) ? (body as unknown as T) : null;
  } catch {
    return null;
  }
}

export const fetchCertDesigns = () => read<CertDesignsView>('view=designs', (b) => isRecord(b.designs));
export const fetchIssuedCerts = (certificate: string | null) =>
  read<IssuedCertsView>(`view=issued${certificate ? `&certificate=${encodeURIComponent(certificate)}` : ''}`, (b) => isRecord(b.issued));

const unknown = (body: string): CertDeskReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the page again before trying again.',
  code: null,
  changed: 'unknown',
});

/** One change. A dropped connection is an unknown outcome: the page reads again and never repeats the change on its own. */
export async function postCertDeskChange(body: Record<string, unknown>): Promise<CertDeskReply> {
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
    const res = await fetch('/api/academy-cert-designs', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const answer: unknown = await res.json().catch(() => null);
    if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string')
      return { ok: true, what: answer.what, warning: typeof answer.warning === 'string' ? answer.warning : null };
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
