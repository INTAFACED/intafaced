/**
 * Waitlist waves as svc-identity returns them (`waitlist.waves.list`, RC-campaigns-03). The reader is strict: a shape that is
 * not exactly this makes the whole read invalid, so the desk never prints a guess. Operator ids only, never emails.
 */

export interface Wave {
  readonly waveNumber: number;
  readonly size: number;
  readonly releasedCount: number;
  readonly flagKey: string;
  readonly releasedBy: string;
  readonly approvedBy: string;
  readonly releasedAt: string;
}

export interface WavesState {
  /** The owner's wave size; null while unset, and then every release refuses `drop.wave_unset`. */
  readonly waveSize: number | null;
  readonly nextWave: number;
  readonly waiting: number;
  readonly waves: readonly Wave[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const whole = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

export function readWave(raw: unknown): Wave | null {
  if (!isRecord(raw)) return null;
  const { waveNumber, size, releasedCount, flagKey, releasedBy, approvedBy, releasedAt } = raw;
  if (!whole(waveNumber, 1) || !whole(size, 1) || !whole(releasedCount, 1)) return null;
  if (typeof flagKey !== 'string' || typeof releasedBy !== 'string' || typeof approvedBy !== 'string' || typeof releasedAt !== 'string')
    return null;
  return { waveNumber, size, releasedCount, flagKey, releasedBy, approvedBy, releasedAt };
}

export function readWavesState(raw: unknown): WavesState | null {
  if (!isRecord(raw)) return null;
  const { waveSize, nextWave, waiting, waves } = raw;
  if (!(waveSize === null || whole(waveSize, 1)) || !whole(nextWave, 1) || !whole(waiting, 0) || !Array.isArray(waves)) return null;
  const read = waves.map(readWave);
  if (read.some((w) => w === null)) return null;
  return { waveSize, nextWave, waiting, waves: read as Wave[] };
}

/** Why the next wave cannot be requested now, or null when it can. The service refuses the same cases itself. */
export function releaseBlocked(state: WavesState): string | null {
  if (state.waveSize === null)
    return 'The owner has not set the wave size (IDENTITY_WAITLIST_WAVE_SIZE), so nobody can be released. Identity refuses every release until it is set.';
  if (state.waiting === 0) return 'Nobody is waiting: everyone on the waitlist has been released.';
  return null;
}
