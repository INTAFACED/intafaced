import { useCallback, useRef } from 'react';

/**
 * A ref that brings its element into view inside whatever scrolls it (a tall dialog's own scroll box) each time `news`
 * changes: the outcome of an action lands at the end of a dialog, and a dialog taller than the window had kept it below
 * its fold, cut off or out of sight (J-derivatives-03 #4 and #7, read BROKEN). `onMount` reveals it when it first appears
 * too; without it, only a later change is news (a list's items stay where the person left them when the dialog opens).
 * A ref callback, not an effect: React calls it again only when `news` changes.
 */
export function useReveal<E extends Element>(news: string, { onMount = false }: { onMount?: boolean } = {}) {
  const seen = useRef<string | null>(null);
  return useCallback(
    (el: E | null) => {
      if (!el) return;
      const before = seen.current;
      seen.current = news;
      if (before === null ? onMount : before !== news) el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    },
    [news, onMount],
  );
}
