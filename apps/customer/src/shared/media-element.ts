/**
 * Keeping a page's media and the browser's own objects in step with a room (AC-videos-01: the Academy player). Each hook
 * knows one browser object and no screen; a room calls these instead of writing its own effect
 * (garden/no-effect-in-product).
 *
 * - `useObjectUrls`: a `blob:` URL per item, made when the list changes and revoked when it is replaced or the room goes.
 *   It is empty until the first URLs are made, so a `<track>` waits for its file.
 * - `useTextTrackModes`: each text track of a `<video>` shown or hidden as asked, again once its `<track>` elements
 *   change (`ready`).
 * - `usePageLeave`: a callback when the page is hidden (another tab, the app sent away) and when the room unmounts, for a
 *   place that must be stored before it is lost.
 * - `useKeepInView`: the child at `index` of a scroll box kept a third of the way down it, inside that box only.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

/** A `blob:` URL for each item of `items` (made by `toBlob`), revoked when `items` is replaced or the room unmounts. */
export function useObjectUrls<T>(items: readonly T[], toBlob: (item: T) => Blob): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  const latest = useRef(toBlob);
  latest.current = toBlob;
  useEffect(() => {
    const made = items.map((item) => URL.createObjectURL(latest.current(item)));
    setUrls(made);
    return () => made.forEach((url) => URL.revokeObjectURL(url));
  }, [items]);
  return urls;
}

/** Sets each text track of the video behind `media` to `modes[i]`, again whenever a mode or `ready` changes. */
export function useTextTrackModes(media: RefObject<HTMLMediaElement | null>, modes: readonly TextTrackMode[], ready: unknown): void {
  const key = modes.join(',');
  useEffect(() => {
    const node = media.current;
    if (!node) return;
    const wanted = key ? key.split(',') : [];
    for (const [i, track] of Array.from(node.textTracks).entries()) track.mode = (wanted[i] as TextTrackMode | undefined) ?? 'disabled';
  }, [media, key, ready]);
}

/** Calls the latest `onLeave` when the page becomes hidden and once more when the room unmounts. */
export function usePageLeave(onLeave: () => void): void {
  const latest = useRef(onLeave);
  latest.current = onLeave;
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') latest.current();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      latest.current();
    };
  }, []);
}

/** Scrolls the box behind `box` so its child at `index` sits a third of the way down, whenever `index` changes. */
export function useKeepInView(box: RefObject<HTMLElement | null>, index: number): void {
  useEffect(() => {
    const list = box.current,
      row = list?.children[index] as HTMLElement | undefined;
    if (list && row) list.scrollTop = row.offsetTop - list.offsetTop - list.clientHeight / 3;
  }, [box, index]);
}
