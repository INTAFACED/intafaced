/**
 * Caller IP on the private stream. Exact IPv4/IPv6 after trim. No invented CIDR.
 * Empty list on the key stays open. Missing IP with a non-empty list fails closed.
 */
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export function normalizeIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Strip IPv4-mapped IPv6 prefix so a bound v4 still matches the socket form.
  const mapped = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  return isIP(mapped) === 0 ? null : mapped;
}

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

/** First x-forwarded-for hop, else x-real-ip, else the TCP peer. Never invent. */
export function callerIpFromUpgrade(req: IncomingMessage): string | null {
  const raw = req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'];
  const forwarded = Array.isArray(raw) ? raw[0] : raw;
  if (typeof forwarded === 'string') {
    const first = normalizeIp(forwarded.split(',')[0] ?? '');
    if (first) return first;
  }
  return normalizeIp(req.socket.remoteAddress);
}
