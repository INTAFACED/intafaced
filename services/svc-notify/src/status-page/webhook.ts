/**
 * A subscriber's own webhook endpoint (SP-status-04). Only https to a public address: a loopback, private, link-local,
 * shared, multicast or reserved address is refused, both for an address written in the URL and for every address its
 * name resolves to. A name that does not resolve is refused too: nothing is stored that cannot be checked.
 */
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export type Resolver = (host: string) => Promise<readonly string[]>;

export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or null. Handles `::` and a dotted IPv4 tail. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1]!.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -tail[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * True for any address that is not a public unicast address. An IPv6 address that carries an IPv4 one (mapped,
 * compatible, NAT64 64:ff9b::/96, 6to4 2002::/16) is judged by the IPv4 address it carries.
 */
export function privateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && g[5] === 0xffff) return v4Private(v4From(g[6]!, g[7]!));
  if (zeroTo(6)) return g[6] === 0 ? true : v4Private(v4From(g[6]!, g[7]!)); // ::, ::1 and IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(v4From(g[6]!, g[7]!));
  if (g[0] === 0x2002) return v4Private(v4From(g[1]!, g[2]!));
  const first = g[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && g[1] === 0x0db8) || // documentation
    (first === 0x2001 && g[1]! < 0x0200) || // Teredo, benchmarking and other IETF special use
    first === 0x0100 // discard-only
  );
}

/**
 * POSTs to a webhook with the address pinned: the name is resolved once, every address it gives is checked, and the
 * connection goes to a checked address. A name that resolves to a private address at send time is refused, so a
 * second lookup cannot slip in another answer. Redirects are not followed.
 */
export type WebhookPost = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ ok: boolean }>;

export function pinnedPost(resolve: Resolver = systemResolver): WebhookPost {
  return (raw, body, headers, timeoutMs) =>
    new Promise((settle, fail) => {
      const url = new URL(raw);
      const req = httpsRequest(
        url,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
          timeout: timeoutMs,
          lookup: (host, options, done) => {
            const answer = isIP(host) ? Promise.resolve([host]) : resolve(host);
            answer.then(
              (addresses) => {
                const address = addresses[0];
                if (!address || addresses.some(privateAddress)) {
                  done(Object.assign(new Error('status.webhook_target_refused'), { code: 'EREFUSED' }), '', 4);
                  return;
                }
                if ((options as { all?: boolean }).all) {
                  (done as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
                    { address, family: isIP(address) },
                  ]);
                } else done(null, address, isIP(address));
              },
              (err: Error) => done(err as NodeJS.ErrnoException, '', 4),
            );
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => settle({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300 }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('webhook timeout')));
      req.on('error', fail);
      req.end(body);
    });
}

/** Null when the URL may be stored and called; otherwise why not. */
export async function webhookTargetProblem(raw: string, resolve: Resolver = systemResolver): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not_a_url';
  }
  if (url.protocol !== 'https:') return 'not_https';
  if (url.username || url.password) return 'credentials_in_url';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    return 'private_address';
  if (isIP(host)) return privateAddress(host) ? 'private_address' : null;
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return 'unresolved';
  }
  if (addresses.length === 0) return 'unresolved';
  return addresses.some(privateAddress) ? 'private_address' : null;
}
