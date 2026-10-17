import { founderMutationHeaders } from '@/lib/founder-browser';
import type { Outcome } from './outcome';

/**
 * Browser side: send one desk action to the console's own BFF (/api/trade-ops/<room>) and get the Outcome back.
 * A dropped connection is "unknown", never a success and never an automatic retry.
 */
export async function tradeOpsAction<T = unknown>(room: string, body: unknown): Promise<Outcome<T>> {
  const asOf = new Date().toISOString();
  try {
    const headers = await founderMutationHeaders();
    const res = await fetch(`/api/trade-ops/${room}`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
    const json: unknown = await res.json().catch(() => null);
    if (json && typeof json === 'object' && 'kind' in json) return json as Outcome<T>;
    return { kind: 'refused', code: `http.${res.status}`, message: 'The console answered without a result.', status: res.status, blocker: null, asOf };
  } catch (error) {
    return {
      kind: 'unknown',
      message:
        error instanceof Error && error.message.includes('session')
          ? error.message
          : 'The connection ended before the console confirmed the result. It may or may not have been applied: read the state again before repeating it.',
      asOf,
    };
  }
}
