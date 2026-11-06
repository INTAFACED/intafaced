/**
 * When the person last used the page (J-identity-06 #4, I-signin-sessions-06). The tab refreshes its sign-in on a timer
 * whether or not anyone is there, so identity cannot tell idle from busy by refreshes alone: every refresh reports the
 * seconds since the last real use, and identity ends the sign-in when that passes the idle limit that applies.
 *
 * The time is kept in localStorage, so it survives a reload and is shared by the person's tabs: a page left shut for an
 * hour reports an hour at its first refresh. Only a real action counts (a press, a key, a scroll, a touch), never the
 * page loading. Without storage nothing is reported, and identity falls back to the time since the last refresh.
 */
export const LAST_ACTIVITY_KEY = 'ifc-last-activity';
const WRITE_EVERY_MS = 5_000;
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Seconds since the last recorded use, or undefined when none was recorded or storage cannot be read. */
export function browserIdleSeconds(now: number = Date.now()): number | undefined {
  try {
    const at = Number(globalThis.localStorage?.getItem(LAST_ACTIVITY_KEY));
    if (!Number.isFinite(at) || at <= 0) return undefined;
    return Math.max(0, Math.floor((now - at) / 1000));
  } catch {
    return undefined;
  }
}

/** Records each real use (at most every few seconds); returns the function that stops listening. */
export function watchActivity(): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  let last = 0;
  const seen = () => {
    const now = Date.now();
    if (now - last < WRITE_EVERY_MS) return;
    last = now;
    try {
      window.localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    } catch {
      // No storage: nothing is reported, and identity judges by the time since the last refresh.
    }
  };
  for (const event of EVENTS) window.addEventListener(event, seen, { passive: true, capture: true });
  return () => {
    for (const event of EVENTS) window.removeEventListener(event, seen, { capture: true });
  };
}
