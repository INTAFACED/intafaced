/** Browser hop for the module ops desks (read only). Same-origin BFF only; no credential is held here. */
import { DESKS } from './catalog';
import { fetchOutcome, type OwnFetch } from './own-server';
import type { DeskView, OpsDeskId } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchDesk(deskId: OpsDeskId, signal?: AbortSignal): Promise<DeskView | null> {
  try {
    const res = await fetch(DESKS[deskId].endpoint, { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && body.deskId === deskId && typeof body.asOf === 'string' && isRecord(body.reads)
      ? (body as unknown as DeskView)
      : null;
  } catch {
    return null;
  }
}

/** One transfer's full record, read on request. A failure says what the console's server answered (see `ownServerFailureText`). */
export async function fetchTransfer(id: string, signal?: AbortSignal): Promise<OwnFetch> {
  return fetchOutcome(`/api/pay-ops/transfer?id=${encodeURIComponent(id)}`, signal);
}

/** The next page of a list whose service gives a page marker, read on request. */
export async function fetchPage(readId: string, cursor: string, signal?: AbortSignal): Promise<OwnFetch> {
  return fetchOutcome(`/api/pay-ops/page?read=${encodeURIComponent(readId)}&cursor=${encodeURIComponent(cursor)}`, signal);
}
