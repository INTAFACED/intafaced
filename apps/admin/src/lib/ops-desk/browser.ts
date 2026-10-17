/** Browser hop for the module ops desks (read only). Same-origin BFF only; no credential is held here. */
import { DESKS } from './catalog';
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
