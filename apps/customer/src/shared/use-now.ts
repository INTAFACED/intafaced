import { useEffect, useState } from 'react';

/** The wall clock in milliseconds, read again every `everyMs`: for a screen that shows when a window has passed. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
