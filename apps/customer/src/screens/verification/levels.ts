import type { VerificationRecord } from '../../features/account/verification-guards';

export type Held = 'none' | 'basic' | 'full' | 'institutional';
export type Level = Exclude<Held, 'none'>;

export const LEVELS: readonly Level[] = ['basic', 'full', 'institutional'];
const rank: Record<Held, number> = { none: 0, basic: 1, full: 2, institutional: 3 };

/** Where one level stands for this person. */
export type LevelState =
  /** The level they hold now. */
  | 'current'
  /** A lower level than the one they hold: already included. */
  | 'included'
  /** A request for this level is waiting for review. */
  | 'pending'
  /** The last request for this level was turned down; they may ask again. */
  | 'declined'
  /** Nothing asked yet. */
  | 'available';

/**
 * `records` come newest first (the service orders them). A request only counts for a level above the one held:
 * an approved record already shows up as the held level, so only pending and rejected ones matter here.
 */
export function levelState(held: Held, level: Level, records: readonly Pick<VerificationRecord, 'tier' | 'status'>[]): LevelState {
  if (held === level) return 'current';
  if (rank[held] > rank[level]) return 'included';
  const latest = records.find((row) => row.tier === level && row.status !== 'expired');
  if (latest?.status === 'pending') return 'pending';
  if (latest?.status === 'rejected') return 'declined';
  return 'available';
}

/** The next level above the one held, or null at the top. */
export function nextLevel(held: Held): Level | null {
  return LEVELS.find((level) => rank[level] > rank[held]) ?? null;
}

/** Levels worth asking for: above the held one, without a request already waiting. */
export function askable(held: Held, records: readonly Pick<VerificationRecord, 'tier' | 'status'>[]): Level[] {
  return LEVELS.filter((level) => {
    const state = levelState(held, level, records);
    return state === 'available' || state === 'declined';
  });
}
