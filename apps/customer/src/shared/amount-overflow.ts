import { useEffect, useRef, useState } from 'react';

/**
 * Whether an exact amount is wider than its row, measured as the row or the digits resize; the row scrolls back to the
 * start when the value changes. Shared by the old `PayAmount` and the Volt rooms' `Amount`, so the measurement is one.
 */
export function useAmountOverflow(value: string) {
  const viewport = useRef<HTMLSpanElement>(null);
  const digits = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const region = viewport.current;
    const token = digits.current;
    if (!region || !token) return;
    const measure = () => setOverflows(region.scrollWidth > region.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(token);
    region.scrollLeft = 0;
    measure();
    return () => observer.disconnect();
  }, [value]);
  return { viewport, digits, overflows };
}
