/**
 * Bar replay: the chart is cut at a past bar and moves forward one bar at a time. It only changes what is drawn; the
 * bars the service sent are kept as they are, and leaving replay draws them all again. The depth is the bars loaded
 * (scroll back or "go to date" loads more, up to the interval's history).
 */
import { useEffect, useMemo, useState } from 'react';
import type { Candle } from '../../data/types';

export const REPLAY_SPEEDS = [1, 2, 4, 10] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** One bar per second at 1x. */
export const REPLAY_STEP_MS = 1000;

export interface Replay {
  /** Index of the last bar drawn. */
  position: number;
  playing: boolean;
  speed: ReplaySpeed;
}

/** Where a replay `barsBack` bars back starts, or how deep it can go. */
export function replayStart(total: number, barsBack: number): { ok: true; position: number } | { ok: false; most: number } {
  if (!Number.isInteger(barsBack) || barsBack < 1 || barsBack >= total) return { ok: false, most: Math.max(0, total - 1) };
  return { ok: true, position: total - 1 - barsBack };
}

/** The bars drawn while a replay runs: up to its position. */
export const replayBars = (bars: readonly Candle[], replay: Replay | null): readonly Candle[] =>
  replay ? bars.slice(0, replay.position + 1) : bars;

/** The replay state with a clock: plays at its speed and stops at the newest bar. */
export function useReplay(total: number) {
  const [replay, setReplay] = useState<Replay | null>(null);
  useEffect(() => {
    if (!replay?.playing) return;
    const timer = setInterval(() => {
      setReplay((now) => {
        if (!now) return now;
        const position = Math.min(total - 1, now.position + 1);
        return { ...now, position, playing: position < total - 1 };
      });
    }, REPLAY_STEP_MS / replay.speed);
    return () => clearInterval(timer);
  }, [replay?.playing, replay?.speed, total]);
  return useMemo(
    () => ({
      replay,
      start: (position: number, speed: ReplaySpeed) => setReplay({ position, playing: false, speed }),
      play: () => setReplay((now) => (now ? { ...now, playing: now.position < total - 1 } : now)),
      pause: () => setReplay((now) => (now ? { ...now, playing: false } : now)),
      step: () => setReplay((now) => (now ? { ...now, playing: false, position: Math.min(total - 1, now.position + 1) } : now)),
      speed: (speed: ReplaySpeed) => setReplay((now) => (now ? { ...now, speed } : now)),
      exit: () => setReplay(null),
    }),
    [replay, total],
  );
}
