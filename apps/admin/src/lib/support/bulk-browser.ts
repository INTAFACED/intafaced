/** Browser hop for the support desk's bulk bar. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { readBulkResults, type BulkChange, type BulkExpected, type BulkRow } from './bulk';
import { readClaimReply } from './browser';
import type { SupportBulkPolicyView } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchBulkPolicy(signal?: AbortSignal): Promise<SupportBulkPolicyView | null> {
  try {
    const res = await fetch('/api/support?view=bulk', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.policy) ? (body as unknown as SupportBulkPolicyView) : null;
  } catch {
    return null;
  }
}

export type BulkReply =
  | { readonly ok: true; readonly summary: string; readonly rows: readonly BulkRow[] }
  | { readonly ok: false; readonly refusal: RefusalView };

const UNKNOWN: Extract<BulkReply, { ok: false }> = {
  ok: false,
  refusal: {
    title: 'The outcome is not known',
    body: 'The console could not tell which of the requests were changed.',
    next: 'Read the queue again to see where each request stands before sending the change a second time.',
    code: null,
    changed: 'unknown',
  },
};

/** Strict reader: only a known answer with every request in it is a success; anything else is "outcome not known". */
export function readBulkReply(raw: unknown, sent: BulkExpected): BulkReply {
  if (isRecord(raw) && raw.ok === true && raw.action === 'bulk' && typeof raw.summary === 'string') {
    const rows = readBulkResults({ batchKey: sent.batchKey, results: raw.results }, sent);
    return rows ? { ok: true, summary: raw.summary, rows } : UNKNOWN;
  }
  const read = readClaimReply(raw);
  return read.ok ? UNKNOWN : read;
}

export interface BulkSend {
  readonly batchKey: string;
  readonly ticketIds: readonly string[];
  readonly change: BulkChange;
  readonly reason?: string;
}

/** Send one bulk change through the console's own server. Never throws: every outcome is a reply the page can show. */
export async function postBulk(send: BulkSend): Promise<BulkReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      refusal: {
        title: 'Nothing was sent',
        body: error instanceof Error ? error.message : 'Your founder session could not be confirmed.',
        next: 'Sign in again, then repeat the step.',
        code: null,
        changed: 'no',
      },
    };
  }
  try {
    const res = await fetch('/api/support', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'bulk', ...send }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return readBulkReply(await res.json().catch(() => null), send);
  } catch {
    return UNKNOWN;
  }
}
