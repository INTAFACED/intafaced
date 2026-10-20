/** Browser hop for the identity keys desk. Same-origin BFF only; no credential is held here. */
import type { Part } from '@/lib/desk/part';
import type { KeysView } from './keys-server';
import type { KeyState } from './keys-model';

export type { KeyState };
export type { Part };
export type KeysDeskView = Pick<KeysView, 'asOf' | 'state'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function fetchKeys(signal?: AbortSignal): Promise<KeysDeskView | null> {
  try {
    const res = await fetch('/api/identity-ops/keys', { cache: 'no-store', credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.state) ? (body as unknown as KeysDeskView) : null;
  } catch {
    return null;
  }
}
