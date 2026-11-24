import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The colours the browser resolved for a list of CSS colour values (`var(--lit-accent)` and the like), read once after
 * the first paint from a hidden probe the caller places: what the page really draws, scheme and direction included.
 * `read` turns the browser's `rgb()` into the caller's form and returns null for one it cannot read; the answer is every
 * value or none, so nothing is ever measured from half the set. Pass `values` and `read` that keep their identity
 * (module constants): they are read again whenever either changes. Kept in step with the DOM, so it lives here (the
 * product's rule for effects).
 */
export function useResolvedColours<T>(values: readonly string[], read: (resolved: string) => T | null) {
  const probe = useRef<HTMLSpanElement>(null);
  const [colours, setColours] = useState<readonly T[] | null>(null);
  useLayoutEffect(() => {
    const el = probe.current;
    if (!el) return;
    const out: T[] = [];
    for (const v of values) {
      el.style.color = v;
      const got = read(getComputedStyle(el).color);
      if (got === null) return setColours(null);
      out.push(got);
    }
    setColours(out);
  }, [values, read]);
  return { probe, colours };
}
