/** Browser hop for the module ops desks (read only). Same-origin BFF only; no credential is held here. */
import { DESKS } from './catalog';
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

/** One transfer's full record, read on request. Null when the console's own server did not answer in the desk's shape. */
export async function fetchTransfer(id: string, signal?: AbortSignal): Promise<ReadOutcome | null> {
  try {
    const res = await fetch(`/api/pay-ops/transfer?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!isRecord(body) || typeof body.asOf !== 'string' || !isRecord(body.part)) return null;
    return body.part.kind === 'ok' || body.part.kind === 'failed' ? (body as unknown as ReadOutcome) : null;
  } catch {
    return null;
  }
}
