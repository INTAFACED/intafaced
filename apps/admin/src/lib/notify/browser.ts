/** Browser hop for the notify health desk (read-only). Same-origin BFF only. */
import type { NotifyView } from './model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchNotify(signal?: AbortSignal): Promise<NotifyView | null> {
  try {
    const res = await fetch('/api/notify-health', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.deliveries) && isRecord(body.health)
      ? (body as unknown as NotifyView)
      : null;
  } catch {
    return null;
  }
}
