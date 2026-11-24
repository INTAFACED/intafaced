import { useEffect, useState } from 'react';

/** The value after it has stopped changing for `ms`, so a search box reads the service once per pause, not once per key. */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
