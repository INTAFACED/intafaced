import 'server-only';
import { upstreamCodeOf, type AdminSessionConfig, type FounderSession } from '@/lib/founder-session';
import { parseAccountMetadata, type AccountMetadata } from './account-metadata';

/**
 * Read one account's operator metadata (J-ops-console-03 #6, #7) through svc-edge with the signed-in founder's OWN token,
 * so svc-ledger records the read under the person before it reads. Used by `/api/ledger-metadata`. Never throws: a
 * refusal keeps the ledger's own code, and an answer that is not this account's metadata is refused rather than shown.
 * The writes go on the treasury transport (`postTreasury`), like a reconciliation control.
 */
export type AccountMetadataOutcome =
  { readonly ok: true; readonly metadata: AccountMetadata } | { readonly ok: false; readonly code: string; readonly status: number };

const TIMEOUT_MS = 8_000;

export async function readAccountMetadataAsFounder(
  founder: { readonly session: FounderSession; readonly config: AdminSessionConfig },
  accountId: string,
): Promise<AccountMetadataOutcome> {
  let upstream: Response;
  let text: string;
  try {
    upstream = await fetch(`${founder.config.edgeUrl}/admin/ledger/accounts/${accountId}/metadata`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${founder.session.accessToken}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
  const metadata = parseAccountMetadata(body, accountId);
  return metadata ? { ok: true, metadata } : { ok: false, code: 'admin.upstream_invalid', status: 502 };
}
