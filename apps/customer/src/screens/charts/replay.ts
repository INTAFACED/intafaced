/**
 * Bar replay: the chart is cut at a past bar and moves forward one bar at a time. It only changes what is drawn; the
 * bars the service sent are kept as they are, and leaving replay draws them all again. The depth is the bars loaded
 * (scroll back or "go to date" loads more, up to the interval's history).
 *
 * Replay takes its own copy of the bars when it starts. Bars that arrive later (older history prepended when panning, a
 * polled window that slides) do not move the cut or the "bar N of M" count while replay runs.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Candle } from '../../data/types';

export const REPLAY_SPEEDS = [1, 2, 4, 10] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** One bar per second at 1x. */
export const REPLAY_STEP_MS = 1000;

export interface Replay {
  /** The bars as they were when replay started. Frozen: the cut and the total never move under the person. */
  readonly bars: readonly Candle[];
  /** Index into `bars` of the last bar drawn. */
  position: number;
  playing: boolean;
  speed: ReplaySpeed;
}

/** Why a replay cannot start from the bars loaded. `most` is the deepest start that would work (0 when there is none). */
export type ReplayRefusal = 'whole' | 'least' | 'deep' | 'few';

/**
 * Where a replay `barsBack` bars back starts, or why it cannot. A value that is not a whole number is refused as such,
 * never rounded. A total of one bar or none leaves no bar to start from.
 */
export function replayStart(
  total: number,
  barsBack: number,
): { ok: true; position: number } | { ok: false; reason: ReplayRefusal; most: number } {
  const most = Math.max(0, total - 1);
  if (!Number.isInteger(barsBack)) return { ok: false, reason: 'whole', most };
  if (most === 0) return { ok: false, reason: 'few', most };
  if (barsBack < 1) return { ok: false, reason: 'least', most };
  if (barsBack > most) return { ok: false, reason: 'deep', most };
  return { ok: true, position: total - 1 - barsBack };
}

/** The bars drawn while a replay runs: up to its position, from the bars it froze when it started. */
export const replayBars = (bars: readonly Candle[], replay: Replay | null): readonly Candle[] =>
  replay ? replay.bars.slice(0, replay.position + 1) : bars;

/** One step of the clock: forward one bar, stopping at the newest bar of the frozen set. */
export function advance(now: Replay): Replay {
  const position = Math.min(now.bars.length - 1, now.position + 1);
  return { ...now, position, playing: position < now.bars.length - 1 };
}

/** The replay state with a clock: plays at its speed and stops at the newest frozen bar. */
export function useReplay() {
  const [replay, setReplay] = useState<Replay | null>(null);
  const playing = replay?.playing ?? false;
  const speed = replay?.speed ?? 1;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setReplay((now) => (now ? advance(now) : now)), REPLAY_STEP_MS / speed);
    return () => clearInterval(timer);
  }, [playing, speed]);
  return useMemo(
    () => ({
      replay,
      /** Starts with `bars` frozen; `position` indexes into them. */
      start: (bars: readonly Candle[], position: number, speed: ReplaySpeed) => setReplay({ bars, position, playing: false, speed }),
      play: () => setReplay((now) => (now ? { ...now, playing: now.position < now.bars.length - 1 } : now)),
      pause: () => setReplay((now) => (now ? { ...now, playing: false } : now)),
      step: () => setReplay((now) => (now ? { ...now, playing: false, position: Math.min(now.bars.length - 1, now.position + 1) } : now)),
      speed: (speed: ReplaySpeed) => setReplay((now) => (now ? { ...now, speed } : now)),
      exit: () => setReplay(null),
    }),
    [replay],
  );
}
