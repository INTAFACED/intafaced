/**
 * A value a room keeps on this device (garden/no-effect-in-product). It is read with `read` when the room starts and
 * whenever `key` changes, and written back to device storage under `key`, as JSON, after it is read and after every
 * change; a write the browser refuses calls `onWriteFailure` and the value stays in the room. Knows no screen.
 */
import { useEffect, useRef, useState } from 'react';

export function useDeviceStored<T>(key: string, read: () => T, onWriteFailure: () => void): [T, (update: T | ((current: T) => T)) => void] {
  const [state, setState] = useState(() => ({ key, value: read() }));
  let current = state;
  if (state.key !== key) {
    current = { key, value: read() };
    setState(current);
  }
  const failed = useRef(onWriteFailure);
  failed.current = onWriteFailure;
  useEffect(() => {
    try {
      localStorage.setItem(state.key, JSON.stringify(state.value));
    } catch {
      failed.current();
    }
  }, [state]);
  return [
    current.value,
    (update) =>
      setState((held) => ({
        key: held.key,
        value: typeof update === 'function' ? (update as (current: T) => T)(held.value) : update,
      })),
  ];
}
