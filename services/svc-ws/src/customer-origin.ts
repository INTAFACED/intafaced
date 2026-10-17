/**
 * Customer-page origin check for credentialed upgrades (`/private/stream`,
 * `/drop-copy/stream`).
 *
 * The public `/stream` stays open: it carries no credential. A browser always
 * sends Origin. A missing Origin is a non-browser client and is allowed.
 * An Origin that equals the upgrade's Host (port included) is the same-origin
 * customer app. Anything else must be on `EDGE_ALLOWED_ORIGINS`, the same list
 * svc-edge uses. A foreign Origin is refused before the token is read.
 */
import type { IncomingMessage } from 'node:http';

const DEV_ORIGINS = ['http://localhost:3100', 'http://127.0.0.1:3100'] as const;
const ENFORCED = new Set(['staging', 'prod']);

export function customerOriginsFromEnv(env: {
  APP_ENV?: string | undefined;
  EDGE_ALLOWED_ORIGINS?: string | undefined;
}): readonly string[] {
  const raw = env.EDGE_ALLOWED_ORIGINS?.trim() ?? '';
  if (raw === '') {
    return ENFORCED.has(env.APP_ENV ?? 'dev') ? [] : DEV_ORIGINS;
  }
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(',')) {
    const entry = item.trim();
    if (entry === '') continue;
    if (entry === '*' || entry.toLowerCase() === 'null') {
      throw new Error(`Invalid EDGE_ALLOWED_ORIGINS entry "${entry}" — list exact origins, never a wildcard`);
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`Invalid EDGE_ALLOWED_ORIGINS entry "${entry}"`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== entry) {
      throw new Error(`Invalid EDGE_ALLOWED_ORIGINS entry "${entry}" — use the exact origin a browser sends`);
    }
    if (seen.has(url.origin)) throw new Error(`EDGE_ALLOWED_ORIGINS lists ${url.origin} more than once`);
    seen.add(url.origin);
    origins.push(url.origin);
  }
  return origins;
}

function headerOne(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function originMatchesRequestHost(origin: string, hostHeader: string): boolean {
  try {
    return hostHeader.trim().toLowerCase() === new URL(origin).host;
  } catch {
    return false;
  }
}

/**
 * `allowlist === undefined` leaves the check off (existing unit tests).
 * An empty list still refuses a foreign Origin.
 */
export function foreignUpgradeOrigin(req: IncomingMessage, allowlist: readonly string[] | undefined): boolean {
  if (allowlist === undefined) return false;
  const origin = headerOne(req.headers.origin);
  if (!origin) return false;
  if (allowlist.includes(origin)) return false;
  const host = headerOne(req.headers.host);
  if (host && originMatchesRequestHost(origin, host)) return false;
  return true;
}
