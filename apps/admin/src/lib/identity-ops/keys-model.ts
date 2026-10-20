/**
 * Founder signing-key state as svc-identity returns it (`authKeys.state`). Ids only: key material never leaves the identity host.
 * The reader is strict: a shape that is not exactly this makes the whole read invalid, so the desk never prints a guess.
 */

export interface KeyState {
  readonly activeKeyId: string;
  readonly previousKeyIds: readonly string[];
  readonly activatedAt: string | null;
  readonly availableKeyIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function readKeyState(raw: unknown): KeyState | null {
  if (!isRecord(raw)) return null;
  const { activeKeyId, previousKeyIds, activatedAt, nextRemoval, availableKeyIds } = raw;
  if (typeof activeKeyId !== 'string' || !strings(previousKeyIds) || !strings(availableKeyIds)) return null;
  if (!(activatedAt === null || typeof activatedAt === 'string')) return null;
  if (!(nextRemoval === null || strings(nextRemoval))) return null;
  return { activeKeyId, previousKeyIds, activatedAt, availableKeyIds };
}

/** Ids the host holds a secret for that are neither signing nor in the overlap. The service still refuses an id used before. */
export function rotationCandidates(state: KeyState): readonly string[] {
  const inUse = new Set([state.activeKeyId, ...state.previousKeyIds]);
  return state.availableKeyIds.filter((id) => !inUse.has(id));
}

/** The exact ids a remove-old request names: the service hashes them sorted and comma-joined, so the request must too. */
export function removalIds(state: KeyState): string | null {
  return state.previousKeyIds.length === 0 ? null : [...state.previousKeyIds].sort().join(',');
}
