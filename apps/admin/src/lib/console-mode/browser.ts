/** Browser hop for the maintenance-mode desk. Same-origin BFF only; no credential is held here. */
import type { ConsoleModeRead } from './server';
import { isRecord } from '@intafaced/contracts/guards';

export async function fetchConsoleMode(signal?: AbortSignal): Promise<ConsoleModeRead | null> {
  try {
    const res = await fetch('/api/console-mode', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.view) ? (body as unknown as ConsoleModeRead) : null;
  } catch {
    return null;
  }
}
