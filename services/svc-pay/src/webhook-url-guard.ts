import { Resolver, lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PayError } from './payment-service.js';

/**
 * SSRF guard for merchant webhook URLs.
 *
 * A merchant chooses the URL and svc-pay POSTs to it from inside our network.
 * Without a guard a merchant can aim that POST at the cloud metadata service,
 * svc-ledger, Postgres, or anything else that only trusts the private network.
 *
 * Three layers, because each one alone is bypassable:
 *
 *   1. `assertPublicWebhookUrl` — syntax. Runs at register time and again at
 *      delivery time (so an endpoint stored before this guard existed is caught
 *      too). Rejects private literal IPs in every spelling `new URL` normalises,
 *      internal-looking hostnames, credentials and infrastructure ports.
 *   2. `resolvePublicAddress` — DNS. A public-looking name can resolve to a
 *      private address. If ANY answer is non-public the target is refused.
 *   3. The caller must CONNECT to the address returned here, never re-resolve
 *      the name (DNS rebinding: a second answer must not swap in 127.0.0.1).
 *      Redirects are never followed either — see merchant-webhooks.ts.
 *
 * Not covered here: the receiver's own behaviour, and public-but-trusted targets
 * (for example our own load balancer IPs are public addresses and pass). Deploy
 * must still apply deny-by-default egress; this guard is a second wall, not the first.
 * This module does not move value.
 */

export interface PublicWebhookUrlOptions {
  /**
   * Permit `http://` and loopback targets (`localhost`, `127.0.0.0/8`, `::1`).
   * dev/test only. The caller derives it from APP_ENV; this module never reads
   * the environment, so production posture is the default (false).
   */
  readonly allowLocalHttp?: boolean;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** One DNS answer, as `dns.lookup({ all: true })` returns it. */
export interface LookupAnswer {
  readonly address: string;
  readonly family: number;
}

/** Injectable DNS for tests. Must return EVERY answer, not just the first. */
export type WebhookResolver = (hostname: string) => Promise<readonly LookupAnswer[]>;

/**
 * `dns.lookup` (getaddrinfo: honours /etc/hosts and nsswitch). Only for the dev/test
 * hatch, where `localhost` must resolve; it runs on the libuv pool and has no
 * timeout of its own, so the caller must bound it.
 */
export const systemResolver: WebhookResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Production resolver: c-ares with its own 2 s x 2 tries limit, so one slow merchant
 * nameserver cannot hold a worker for the system default of tens of seconds. Returns
 * every A then every AAAA answer. It ignores /etc/hosts on purpose.
 */
const publicDns = new Resolver({ timeout: 2000, tries: 2 });
export const publicDnsResolver: WebhookResolver = async (hostname) => {
  const [v4, v6] = await Promise.allSettled([publicDns.resolve4(hostname), publicDns.resolve6(hostname)]);
  const out: LookupAnswer[] = [];
  if (v4.status === 'fulfilled') for (const address of v4.value) out.push({ address, family: 4 });
  if (v6.status === 'fulfilled') for (const address of v6.value) out.push({ address, family: 6 });
  if (out.length === 0) {
    throw v4.status === 'rejected' ? v4.reason : new Error('ENODATA');
  }
  return out;
};

/**
 * Ports that belong to our own infrastructure (Postgres, Redis, NATS client and
 * monitoring, Prometheus, Loki). A public IP is a public IP, but there is no
 * reason for a merchant receiver to live there.
 */
const INFRA_PORTS: ReadonlySet<number> = new Set([5432, 6379, 4222, 8222, 9090, 3100]);

/** Internal-only DNS suffixes. `.svc` / `.cluster.local` are Kubernetes service names. */
const INTERNAL_SUFFIXES = [
  '.local',
  '.internal',
  '.localhost',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.localdomain',
  '.home.arpa',
  '.svc',
] as const;

/** Names that mean "us". Single-label names are refused anyway; this is belt and braces. */
const INTERNAL_NAMES: ReadonlySet<string> = new Set(['localhost', 'postgres', 'nats', 'redis']);

function invalid(message: string): never {
  throw new PayError(`${message} NOTHING WAS ATTEMPTED.`, 'pay.webhook_url_invalid');
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

// ── IP classification ───────────────────────────────────────────────────────

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes of an IPv6 address, or null if malformed. Handles `::` and a dotted-quad tail. */
function parseV6(ip: string): number[] | null {
  let text = ip;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = parseV4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  if (tail.length === 4) {
    bytes[12] = tail[0]!;
    bytes[13] = tail[1]!;
    bytes[14] = tail[2]!;
    bytes[15] = tail[3]!;
  }
  return bytes;
}

function isPublicV4(b: readonly number[], allowLoopback: boolean): boolean {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!];
  if (a === 127) return allowLoopback;
  if (a === 0) return false; // "this network", 0.0.0.0
  if (a === 10) return false;
  if (a === 100 && c >= 64 && c <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && c === 254) return false; // link-local incl. cloud metadata
  if (a === 172 && c >= 16 && c <= 31) return false;
  if (a === 192 && c === 0 && d === 0) return false; // IETF protocol assignments
  if (a === 192 && c === 0 && d === 2) return false; // TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return false; // 6to4 relay anycast
  if (a === 192 && c === 168) return false;
  if (a === 198 && (c === 18 || c === 19)) return false; // benchmarking
  if (a === 198 && c === 51 && d === 100) return false; // TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(b: readonly number[], allowLoopback: boolean): boolean {
  const embedded = (at: number) => isPublicV4(b.slice(at, at + 4), allowLoopback);
  const zeroPrefix = (n: number) => b.slice(0, n).every((x) => x === 0);
  // ::1 loopback.
  if (zeroPrefix(15) && b[15] === 1) return allowLoopback;
  // ::ffff:a.b.c.d IPv4-mapped.
  if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) return embedded(12);
  // 64:ff9b::/96 NAT64 — a gateway will connect to the embedded v4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return embedded(12);
  // ::/96 — unspecified and deprecated IPv4-compatible.
  if (zeroPrefix(12)) return false;
  // Only global unicast 2000::/3 can be public; everything else (ULA fc00::/7,
  // link-local fe80::/10, site-local, multicast ff00::/8, ...) is refused.
  if ((b[0]! & 0xe0) !== 0x20) return false;
  // 2002::/16 6to4 — the gateway connects to the v4 in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return embedded(2);
  // 2001::/23 IETF assignments (Teredo, ORCHID, benchmarking, ...) and 2001:db8::/32 docs.
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2]! & 0xfe) === 0x00) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;
  // 3fff::/20 documentation.
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0x00) return false;
  return true;
}

/**
 * True when `ip` (a v4 or v6 literal, no brackets) is a globally routable
 * address. Anything unparseable is NOT public. `allowLoopback` is the dev/test
 * escape hatch and admits 127.0.0.0/8 and ::1 only — never other private ranges.
 */
export function isPublicIpAddress(ip: string, opts: { allowLoopback?: boolean } = {}): boolean {
  const allowLoopback = opts.allowLoopback === true;
  const family = isIP(ip);
  if (family === 4) {
    const b = parseV4(ip);
    return b !== null && isPublicV4(b, allowLoopback);
  }
  if (family === 6) {
    const b = parseV6(ip);
    return b !== null && isPublicV6(b, allowLoopback);
  }
  return false;
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || (parseV4(host)?.[0] === 127 && isIP(host) === 4);
}

// ── Syntactic check ─────────────────────────────────────────────────────────

/**
 * Throws `pay.webhook_url_invalid` unless `url` could plausibly be a public
 * merchant receiver. Returns the parsed URL. Syntax only: it cannot see what a
 * hostname resolves to — `resolvePublicAddress` does that at delivery time.
 *
 * Ports: 443 and any port >= 1024 are accepted, except the infra ports in
 * INFRA_PORTS. Low ports other than 443 are refused (80 would only ever be
 * http, and `https://host:22` is a port scan). Loopback in dev/test skips the
 * port rule so a local receiver can listen anywhere.
 */
export function assertPublicWebhookUrl(url: string, opts: PublicWebhookUrlOptions = {}): URL {
  const allowLocal = opts.allowLocalHttp === true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid('Webhook URL is not a valid absolute URL.');
  }
  if (parsed.username || parsed.password) {
    invalid('Webhook URL must not embed credentials.');
  }

  // `new URL` has already folded decimal / hex / octal IPv4 spellings into a
  // dotted quad and IPv6 into compressed lowercase form. Drop a trailing dot
  // so `localhost.` and `internal.` cannot dodge the name rules.
  const host = stripBrackets(parsed.hostname.toLowerCase()).replace(/\.$/, '');
  if (host === '') invalid('Webhook URL has no host.');
  const literal = isIP(host) !== 0;
  const local = isLocalHost(host);

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowLocal && local)) {
    invalid(
      allowLocal
        ? 'Webhook URL must be https (http is only allowed for localhost).'
        : 'Webhook URL must be https (http is only allowed for localhost in dev/test).',
    );
  }

  if (local && allowLocal) return parsed;

  if (literal) {
    if (!isPublicIpAddress(host)) invalid('Webhook URL points at a private, loopback, link-local or reserved address.');
  } else {
    if (INTERNAL_NAMES.has(host) || host.startsWith('svc-')) invalid('Webhook URL points at an internal service name.');
    if (!host.includes('.')) invalid('Webhook URL host must be a fully qualified public hostname.');
    if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) invalid('Webhook URL host is an internal-only name.');
  }

  const port = parsed.port === '' ? 443 : Number(parsed.port);
  if (parsed.protocol === 'https:' && (port === 443 || port >= 1024) && !INFRA_PORTS.has(port)) return parsed;
  return invalid('Webhook URL port is not allowed (use 443, or a port from 1024 up that is not an infrastructure port).');
}

// ── DNS check ───────────────────────────────────────────────────────────────

/**
 * Resolve `hostname` and return EVERY vetted address, in connect order.
 *
 * Every answer must be public: if a hostname has one public and one private
 * A record we refuse, because the connecting client may pick either. The caller
 * must connect only to the returned addresses and keep the original hostname only
 * for SNI and the Host header; it must not resolve the name a second time.
 *
 * Order: the resolver's order, but families alternate (v4, v6, v4, ...) starting
 * with the first answer's family, so an IPv6-first answer on an IPv4-only host
 * falls back to IPv4 on the next candidate.
 *
 * Throws `pay.webhook_url_invalid` on any refusal, including a resolver error
 * (fail closed). `allowLoopback` is the dev/test hatch and admits loopback only.
 * The resolver has no time limit here; the caller bounds the whole call.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolver: WebhookResolver = publicDnsResolver,
  opts: { allowLoopback?: boolean } = {},
): Promise<readonly ResolvedAddress[]> {
  const host = stripBrackets(hostname.toLowerCase()).replace(/\.$/, '');
  let answers: readonly LookupAnswer[];
  if (isIP(host) !== 0) {
    // A literal needs no DNS; vet it directly so there is no second answer to race.
    answers = [{ address: host, family: isIP(host) }];
  } else {
    try {
      answers = await resolver(host);
    } catch {
      return invalid('Webhook host could not be resolved.');
    }
  }
  if (answers.length === 0) return invalid('Webhook host resolved to no addresses.');
  for (const a of answers) {
    if (!isPublicIpAddress(a.address, opts)) {
      return invalid('Webhook host resolves to a private, loopback, link-local or reserved address.');
    }
  }
  const all: ResolvedAddress[] = answers.map((a) => ({ address: a.address, family: isIP(a.address) === 6 ? 6 : 4 }));
  const queues: Record<4 | 6, ResolvedAddress[]> = { 4: all.filter((a) => a.family === 4), 6: all.filter((a) => a.family === 6) };
  let next: 4 | 6 = all[0]!.family;
  const ordered: ResolvedAddress[] = [];
  while (ordered.length < all.length) {
    const take = queues[next].shift() ?? queues[next === 4 ? 6 : 4].shift();
    if (take) ordered.push(take);
    next = next === 4 ? 6 : 4;
  }
  return ordered;
}

/** First vetted address only. Prefer `resolvePublicAddresses` for delivery. */
export async function resolvePublicAddress(
  hostname: string,
  resolver: WebhookResolver = publicDnsResolver,
  opts: { allowLoopback?: boolean } = {},
): Promise<ResolvedAddress> {
  return (await resolvePublicAddresses(hostname, resolver, opts))[0]!;
}
