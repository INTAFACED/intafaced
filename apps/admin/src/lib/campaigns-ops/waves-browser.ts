/** Browser hop for the waitlist waves desk. Same-origin BFF only; no credential is held here. */
import type { WavesView } from './waves-server';

export type WavesDeskView = WavesView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchWaves(signal?: AbortSignal): Promise<WavesDeskView | null> {
  try {
    const res = await fetch('/api/more-ops/waves', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.state) ? (body as unknown as WavesDeskView) : null;
  } catch {
    return null;
  }
}
