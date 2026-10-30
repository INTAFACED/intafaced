import { UPSTREAMS } from './routes.js';

/**
 * The public status badge svc-notify serves under its edge prefix (`/status/badge.svg`).
 *
 * Every other proxied answer keeps only its content type. The badge is an image
 * other sites hot-link, and svc-notify sets two headers on it that were lost at
 * the door:
 *
 * - Its cache life. `public, max-age=N` follows the reading's age, and a blank or
 *   stale reading is `no-cache, max-age=0`, so a badge is never cached past the
 *   point it would mislead.
 * - Its content security policy, which allows no script when the image is opened
 *   on its own as a document on this origin.
 *
 * Only this one exact path gets them; every other path keeps the headers it had.
 */

const NOTIFY_PREFIX = UPSTREAMS.find((u) => u.module === 'notify')?.prefix ?? '/api/notify';
export const STATUS_BADGE_PATH = `${NOTIFY_PREFIX}/status/badge.svg`;

const BADGE_HEADERS = ['cache-control', 'content-security-policy'] as const;

/** The badge's own cache and content policy, on the badge path only. */
export function statusBadgeHeaders(pathname: string, upstream: { get(name: string): string | null }): Record<string, string> {
  if (pathname !== STATUS_BADGE_PATH) return {};
  const out: Record<string, string> = {};
  for (const name of BADGE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}
