/**
 * Saving what a room holds to this device each time it changes (garden/no-effect-in-product: a room calls this instead
 * of writing its own effect). The first value is the one just read from the device, so it is not written back.
 */
import { useEffect, useRef } from 'react';

/**
 * Writes `value` under `key` with `write` each time either changes after the first render; `onSaved` hears whether the
 * write held (a failed write is shown, never dropped).
 */
export function useSaveOnChange<T>(value: T, key: string, write: (key: string, value: T) => boolean, onSaved: (ok: boolean) => void): void {
  const latest = useRef({ write, onSaved });
  latest.current = { write, onSaved };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    latest.current.onSaved(latest.current.write(key, value));
  }, [value, key]);
}
