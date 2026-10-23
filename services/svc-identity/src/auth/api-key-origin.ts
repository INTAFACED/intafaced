/**
 * Domain whitelist on API keys.
 *
 * Empty list = unrestricted (server bots, curl, edge workers).
 * Non-empty = request origin host must match an entry (hostname or full URL).
 * Missing origin with a non-empty list fails closed — a browser key that forgot
 * its Origin header must not open the door.
 */
export function apiKeyOriginAllowed(whitelist: readonly string[], requestOrigin: string | null | undefined): boolean {
  if (whitelist.length === 0) return true;
  const host = normalizeOriginHost(requestOrigin);
  if (!host) return false;
  for (const entry of whitelist) {
    const allowed = normalizeOriginHost(entry);
    if (!allowed) continue;
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/**
 * True when `next` lets the key be used from more origins than `current`.
 * Empty means unrestricted, so clearing a non-empty list opens the key.
 */
export function originAllowlistWidens(current: readonly string[], next: readonly string[]): boolean {
  const cur = new Set<string>();
  for (const entry of current) {
    const host = normalizeOriginHost(entry);
    if (host) cur.add(host);
  }
  const nxt: string[] = [];
  for (const entry of next) {
    const host = normalizeOriginHost(entry);
    if (host) nxt.push(host);
  }
  if (cur.size === 0) return false;
  if (nxt.length === 0) return true;
  for (const host of nxt) if (!cur.has(host)) return true;
  return false;
}

export function normalizeOriginHost(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed).hostname || null;
    }
    // host[:port][/path] — take host only
    const hostPart = trimmed.split('/')[0] ?? '';
    const host = hostPart.split(':')[0] ?? '';
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}
