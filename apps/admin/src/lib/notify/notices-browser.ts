/** Browser hop for the announcement desk. Same-origin BFF only; changes go through the incident desk's change hop. */
import type { NoticesDeskView } from './notices-model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchNoticesDesk(): Promise<NoticesDeskView | null> {
  try {
    const res = await fetch('/api/notify-notices', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.announcements) && isRecord(body.categories)
      ? (body as unknown as NoticesDeskView)
      : null;
  } catch {
    return null;
  }
}
