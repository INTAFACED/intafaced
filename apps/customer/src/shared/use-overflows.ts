import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether `region` is narrower than what it holds (`content`), kept up to date as either resizes: the one browser
 * listener a wide figure needs to offer its own scroll. The region starts scrolled to its start each time `key` changes.
 */
export function useOverflows(region: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, key: unknown): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const box = region.current;
    const inner = content.current;
    if (!box || !inner) return;
    const measure = () => setOverflows(box.scrollWidth > box.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(inner);
    box.scrollLeft = 0;
    measure();
    return () => observer.disconnect();
  }, [region, content, key]);
  return overflows;
}
