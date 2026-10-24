/**
 * Where an alert channel may POST (OPS-alerts-02). An operator saves the URL and svc-ops calls it from inside the
 * network, so a loopback, private, link-local, shared or reserved address is refused: written in the URL at save
 * time, and for every address the name resolves to at send time. The connection goes to the address that was
 * checked, so a second DNS answer cannot swap one in. Redirects are not followed.
 *
 * Loopback and plain http stay open only where APP_ENV is dev or test (or under the test runner), for the local
 * stack and tests. Deploy still needs deny-by-default egress; this is the second wall.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { OPS_CHANNEL_TARGET_UNSET } from '@intafaced/contracts';
import { OpsError } from '../codes.js';

export type ChannelResolver = (host: string) => Promise<readonly string[]>;

const systemResolver: ChannelResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Read per call, like the channel key, so the posture follows the process it runs in. */
export function localTargetsAllowed(): boolean {
  const appEnv = process.env.APP_ENV?.trim();
  return appEnv === 'dev' || appEnv === 'test' || process.env.NODE_ENV === 'test';
}

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

function v6Private(ip: string): boolean {
  const text = ip.toLowerCase().replace(/%.*$/, '');
  if (text === '::' || text === '::1') return true;
  // IPv4-compatible (::/96, deprecated) is never a public endpoint; WHATWG writes ::a.b.c.d as ::xxxx:yyyy.
  if (/^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(text)) return true;
  // IPv4-mapped or -compatible: judge the IPv4 address it carries.
  const tail = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) return v4Private(tail[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return v4Private(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = parseInt(text.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local
    (first & 0xff00) === 0xff00 || // multicast
    text.startsWith('64:ff9b:') || // NAT64
    text.startsWith('2002:') || // 6to4
    text.startsWith('2001:db8:') // documentation
  );
}

function isLoopback(ip: string): boolean {
  return isIP(ip) === 4 ? ip.startsWith('127.') : ip === '::1';
}

/** True for any address svc-ops must not call. Loopback passes only when local targets are allowed. */
export function refusedAddress(ip: string, allowLocal: boolean): boolean {
  const kind = isIP(ip);
  if (kind === 0) return true;
  if (allowLocal && isLoopback(ip)) return false;
  return kind === 4 ? v4Private(ip) : v6Private(ip);
}

const INTERNAL_NAME = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');

/** Save-time check: scheme, credentials elsewhere, and an address written into the URL. Throws a typed refusal. */
export function assertChannelTarget(url: URL, allowLocal: boolean = localTargetsAllowed()): void {
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) {
    throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'The channel URL must be https. Nothing was saved.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowLocal && INTERNAL_NAME(host)) {
    throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'The channel URL names an internal host. Nothing was saved.');
  }
  if (isIP(host) && refusedAddress(host, allowLocal)) {
    throw new OpsError(OPS_CHANNEL_TARGET_UNSET, 'The channel URL is a private address. Nothing was saved.');
  }
}

/** The most of a receiver's reply svc-ops reads before it stops; only the status matters. */
export const CHANNEL_REPLY_CAP_BYTES = 64 * 1024;

/**
 * POST with the address pinned. Resolves once, refuses if any answer is not public, connects to a checked address.
 * `timeoutMs` bounds the whole call, connect to last byte, so a receiver that trickles its reply cannot hold the send.
 * Resolves `ok` from the status; rejects on a refused target, a network error or the deadline.
 */
export function pinnedChannelPost(
  raw: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  resolve: ChannelResolver = systemResolver,
  allowLocal: boolean = localTargetsAllowed(),
): Promise<{ ok: boolean; status: number }> {
  return new Promise((settle, fail) => {
    const url = new URL(raw);
    assertChannelTarget(url, allowLocal);
    let finished = false;
    const finish = (outcome: { ok: boolean; status: number } | Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (outcome instanceof Error) fail(outcome);
      else settle(outcome);
    };
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
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
              if (!address || addresses.some((ip) => refusedAddress(ip, allowLocal))) {
                done(Object.assign(new Error('ops.channel_target_refused'), { code: 'EREFUSED' }), '', 4);
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
        const status = res.statusCode ?? 0;
        const outcome = { ok: status >= 200 && status < 300, status };
        let read = 0;
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          if (read > CHANNEL_REPLY_CAP_BYTES) {
            finish(outcome);
            req.destroy();
          }
        });
        res.on('end', () => finish(outcome));
        res.on('error', (err) => finish(err));
      },
    );
    const deadline = setTimeout(() => {
      const err = new Error('channel timeout');
      finish(err);
      req.destroy(err);
    }, timeoutMs);
    req.on('timeout', () => req.destroy(new Error('channel timeout')));
    req.on('error', (err) => finish(err));
    req.end(body);
  });
}
