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

/**
 * The TCP peer. This socket is outside svc-edge, which is the door that
 * strips a client x-forwarded-for and writes the real one. A header here
 * is the caller talking. Never invent an address.
 */
export function callerIpFromUpgrade(req: IncomingMessage): string | null {
  return normalizeIp(req.socket.remoteAddress);
}

/**
 * The caller of a public upgrade behind a stated reverse proxy (`WS_TRUST_PROXY`, exact addresses only). A peer not on
 * the list is the caller, whatever it sends. A listed peer's `x-forwarded-for` is read from its right end: each listed
 * hop is skipped and the first address not on the list is the caller. An unreadable entry stops the walk at the last
 * listed hop, so a forged or broken header can only fall back to the proxy's own address, never pick a new one.
 */
export function publicCallerIp(req: IncomingMessage, trustedProxies: readonly string[]): string | null {
  const peer = callerIpFromUpgrade(req);
  if (peer === null || trustedProxies.length === 0) return peer;
  const trusted = new Set(trustedProxies.map((t) => normalizeIp(t)).filter((t): t is string => t !== null));
  if (!trusted.has(peer)) return peer;
  const raw = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').filter((h) => h.trim() !== '');
  let caller = peer;
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = normalizeIp(hops[i]);
    if (hop === null) return caller;
    caller = hop;
    if (!trusted.has(hop)) return hop;
  }
  return caller;
}
