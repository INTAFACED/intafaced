import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { compareDecimal } from './deps';

/**
 * Direction of the last price change ("last tick"), kept until the next change. Resets when `key` changes
 * (another market), so one market's tick never colours another's price. Null until the first change.
 */
export function useTickDirection(value: string | null, key: string): 'up' | 'down' | null {
  const memory = useRef<{ key: string; value: string | null; direction: 'up' | 'down' | null }>({ key, value, direction: null });
  if (memory.current.key !== key) memory.current = { key, value, direction: null };
  const m = memory.current;
  if (value !== null && m.value !== null && value !== m.value) {
    const order = compareDecimal(value, m.value);
    if (order !== null && order !== 0) m.direction = order > 0 ? 'up' : 'down';
  }
  m.value = value;
  return m.direction;
}

/** 'up' or 'down' for 600 ms after the value changes (the price flash, UI-SPEC 2.5). Never on the first value. */
export function useFlash(value: string | null, key: string): 'up' | 'down' | null {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const previous = useRef<{ key: string; value: string | null }>({ key, value });
  useEffect(() => {
    const before = previous.current;
    previous.current = { key, value };
    if (before.key !== key || before.value === null || value === null || before.value === value) return;
    const order = compareDecimal(value, before.value);
    if (order === null || order === 0) return;
    setFlash(order > 0 ? 'up' : 'down');
    const timer = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(timer);
  }, [value, key]);
  return flash;
}

/** Re-render on a timer, for things that age (a book snapshot's staleness). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Is the viewport at least `px` wide? Panels the layout hides keep polling slowly instead of at full speed. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}
