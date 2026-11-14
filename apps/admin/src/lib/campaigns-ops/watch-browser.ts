/** Browser hop for the campaign watch desk. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RuleAnswer } from './builder-browser';

const URL_ = '/api/more-ops/campaigns/watch';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function answerOf<T>(answer: unknown, unknown: string): RuleAnswer<T> {
  // The console's own route shaped it from the service's schema-checked answer (watch-server.ts).
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

export async function watchRead<T>(query: string): Promise<RuleAnswer<T>> {
  try {
    const res = await fetch(`${URL_}${query}`, { cache: 'no-store', credentials: 'same-origin' });
    return answerOf<T>(await res.json().catch(() => null), 'The console answered in a shape it does not understand.');
  } catch {
    return answerOf<T>(null, 'svc-campaigns could not be read.');
  }
}

/** One change. A dropped connection is an unknown outcome: the desk reads again and never repeats the change on its own. */
export async function watchChange<T>(body: Record<string, unknown>): Promise<RuleAnswer<T>> {
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

/** An export's file while its link is valid, or the service's refusal (past its validity: `campaigns.export_expired`). */
export async function watchDownload(
  exportId: string,
): Promise<{ ok: true; blob: Blob; filename: string } | Extract<RuleAnswer<never>, { ok: false }>> {
  try {
    const res = await fetch(`${URL_}?export=${encodeURIComponent(exportId)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok && (res.headers.get('content-type') ?? '').startsWith('text/csv')) {
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${exportId}.csv`;
      return { ok: true, blob: await res.blob(), filename: name };
    }
    return answerOf<never>(await res.json().catch(() => null), 'The export could not be read.') as Extract<
      RuleAnswer<never>,
      { ok: false }
    >;
  } catch {
    return answerOf<never>(null, 'The export could not be read.') as Extract<RuleAnswer<never>, { ok: false }>;
  }
}

/** Saves a file the browser holds, by a link it clicks once. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The codes of a CSV: the first column of each row, a header row named `code` left out, blanks skipped. */
export function codesOfCsv(text: string): string[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(',')[0]!
        .trim()
        .replace(/^"(.*)"$/, '$1'),
    )
    .filter((c) => c.length > 0);
  return rows[0]?.toLowerCase() === 'code' ? rows.slice(1) : rows;
}
