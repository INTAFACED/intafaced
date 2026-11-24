/**
 * An awaited back-off poll, kept in step with a room, so the room writes no effect of its own: `check` runs at once, and each time a
 * check ends the next one waits `nextWait()` ms, so a slow check never overlaps the next and the wait can grow with each
 * miss (5, 10, 20, then 60 s). `wake`, when given, subscribes a "check now" signal that runs `check` once more without
 * moving the timer.
 *
 * The loop belongs to `key`: a new key, `null` or leaving the screen stops it, and a check that ends after that schedules
 * nothing. The latest `check` and `nextWait` run, so a room passes fresh closures every render.
 */
import { useEffect, useRef } from 'react';

export function useBackoffPoll(
  key: string | null,
  check: () => Promise<void>,
  nextWait: () => number,
  wake?: (now: () => void) => () => void,
): void {
  const latest = useRef({ check, nextWait, wake });
  latest.current = { check, nextWait, wake };
  useEffect(() => {
    if (key === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      await latest.current.check();
      if (stopped) return;
      timer = setTimeout(() => void loop(), latest.current.nextWait());
    };
    void loop();
    const unwake = latest.current.wake?.(() => void latest.current.check());
    return () => {
      stopped = true;
      clearTimeout(timer);
      unwake?.();
    };
  }, [key]);
}
