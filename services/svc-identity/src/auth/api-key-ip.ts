/**
 * IP allowlist on API keys.
 *
 * Empty list = unrestricted (server bots, curl, edge workers).
 * Non-empty = request IP must exactly match an entry after trim (IPv4 or IPv6).
 * Missing / blank IP with a non-empty list fails closed — a bound key that
 * forgot its address must not open the door.
 * Invalid list entries (CIDR, hostnames, junk) never match. No invented CIDR.
 */
import { isIP } from 'node:net';

export function apiKeyIpAllowed(allowlist: readonly string[], requestIp: string | null | undefined): boolean {
  if (allowlist.length === 0) return true;
  const ip = normalizeIp(requestIp);
  if (!ip) return false;
  for (const entry of allowlist) {
    const allowed = normalizeIp(entry);
    if (!allowed) continue;
    if (ip === allowed) return true;
  }
  return false;
}

/**
 * True when `next` lets the key be used from more places than `current`.
 * Empty means unrestricted, so clearing a non-empty list opens the key.
 * Adding addresses to an already-empty list narrows it.
 */
export function ipAllowlistWidens(current: readonly string[], next: readonly string[]): boolean {
  const cur = new Set<string>();
  for (const entry of current) {
    const ip = normalizeIp(entry);
    if (ip) cur.add(ip);
  }
  const nxt: string[] = [];
  for (const entry of next) {
    const ip = normalizeIp(entry);
    if (ip) nxt.push(ip);
  }
  if (cur.size === 0) return false;
  if (nxt.length === 0) return true;
  for (const ip of nxt) if (!cur.has(ip)) return true;
  return false;
}

/** Trim + IPv4/IPv6 literal. Returns null for blank, CIDR, hostname, or junk. */
export function normalizeIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isIP(trimmed) === 0 ? null : trimmed;
}
