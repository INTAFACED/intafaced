/** Browser hop for the module ops desks (read only). Same-origin BFF only; no credential is held here. */
import { DESKS } from './catalog';
import { fetchOutcome, isReadOutcome, type OwnFetch } from './own-server';
import type { DeskView, OpsDeskId, ReadOutcome } from './types';

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

/** One customer's balances (finance-treasury desk), read on request. */
export async function fetchCustomerBalances(userId: string, signal?: AbortSignal): Promise<OwnFetch> {
  return fetchOutcome(`/api/bank-ops/customer?user=${encodeURIComponent(userId)}`, signal);
}

export type EntriesFetch =
  { readonly ok: true; readonly entries: ReadOutcome; readonly check: ReadOutcome } | Extract<OwnFetch, { ok: false }>;

/** One page of the entries behind a customer's balance in one coin, with svc-bank's sum check from the same call. */
export async function fetchCustomerEntries(
  userId: string,
  assetId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<EntriesFetch> {
  const url = `/api/bank-ops/customer?user=${encodeURIComponent(userId)}&asset=${encodeURIComponent(assetId)}${
    cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
  }`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
  } catch {
    return { ok: false, status: null, code: null };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && isRecord(body) && isReadOutcome(body.entries) && isReadOutcome(body.check)) {
    return { ok: true, entries: body.entries, check: body.check };
  }
  const code =
    isRecord(body) && typeof body.error === 'string' ? body.error : isRecord(body) && typeof body.code === 'string' ? body.code : null;
  return { ok: false, status: res.ok ? null : res.status, code };
}
