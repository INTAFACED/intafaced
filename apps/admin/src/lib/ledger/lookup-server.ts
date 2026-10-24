import 'server-only';
import { upstreamCodeOf, type AdminSessionConfig, type FounderSession } from '@/lib/founder-session';
import { parseLookupAnswer, type LedgerLookupAnswer, type LedgerLookupQuery } from './lookup';

/**
 * One ledger lookup, read through svc-edge's named lookup route with the signed-in founder's OWN token (never a deployment
 * credential), so svc-ledger records the lookup under the person before it reads (owner decision 2026-10-23: `admin:read`
 * with a second factor). Used by `/api/ledger-lookup` and by the cross-desk search. Never throws: a refusal keeps the
 * ledger's own code, and an answer that is not the shape asked for is refused rather than shown.
 */
export type LedgerLookupOutcome =
  { readonly ok: true; readonly answer: LedgerLookupAnswer } | { readonly ok: false; readonly code: string; readonly status: number };

const TIMEOUT_MS = 6_000;

export async function readLedgerLookup(
  founder: { readonly session: FounderSession; readonly config: AdminSessionConfig },
  query: LedgerLookupQuery,
): Promise<LedgerLookupOutcome> {
  const path =
    'txId' in query
      ? `/admin/ledger/transactions/${query.txId}`
      : `/admin/ledger/trace?businessKey=${encodeURIComponent(query.businessKey)}`;
  let upstream: Response;
  let text: string;
  try {
    upstream = await fetch(`${founder.config.edgeUrl}${path}`, {
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
  const answer = parseLookupAnswer(query, body);
  return answer ? { ok: true, answer } : { ok: false, code: 'admin.upstream_invalid', status: 502 };
}
