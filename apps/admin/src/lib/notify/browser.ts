/** Browser hop for the notify health desk (read-only). Same-origin BFF only. */
import type { NotifyView } from './model';
import { isRecord } from '@intafaced/contracts/guards';

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
