import 'server-only';
import { upstreamCodeOf, type AdminSessionConfig, type FounderSession } from '@/lib/founder-session';
import { deskSearch, parseDeskAnswer, type LedgerDeskAnswer, type LedgerDeskRead } from './desk';

/**
 * One ledger desk read (the transaction list, the account address search or the counts), read through svc-edge's named
 * route with the signed-in founder's OWN token (never a deployment credential), so svc-ledger records a page of the list
 * or the search under the person before it reads. Used by `/api/ledger-desk/[read]`. Never throws: a refusal keeps the
 * ledger's own code, and an answer that is not the shape asked for is refused rather than shown.
 */
export type LedgerDeskOutcome =
  { readonly ok: true; readonly answer: LedgerDeskAnswer } | { readonly ok: false; readonly code: string; readonly status: number };

const TIMEOUT_MS = 8_000;

export async function readLedgerDesk(
  founder: { readonly session: FounderSession; readonly config: AdminSessionConfig },
  read: LedgerDeskRead,
  query: Readonly<Record<string, string>>,
): Promise<LedgerDeskOutcome> {
  const search = deskSearch(read, query);
  let upstream: Response;
  let text: string;
  try {
    upstream = await fetch(`${founder.config.edgeUrl}/admin/ledger/${read}${search ? `?${search}` : ''}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${founder.session.accessToken}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Read inside the same deadline: a body that stops arriving is an unavailable ledger, not a bad shape.
    text = await upstream.text();
  } catch {
    return { ok: false, code: 'admin.upstream_unavailable', status: 503 };
  }
  const body: unknown = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  })();
  if (!upstream.ok) {
    const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
    return { ok: false, code: upstreamCodeOf(body) ?? `http.${status}`, status };
  }
  const answer = parseDeskAnswer(read, query, body);
  return answer ? { ok: true, answer } : { ok: false, code: 'admin.upstream_invalid', status: 502 };
}
