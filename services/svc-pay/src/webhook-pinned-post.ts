import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ResolvedAddress } from './webhook-url-guard.js';

/**
 * One webhook POST to addresses that were already vetted.
 *
 * `fetch` cannot be used: it resolves the hostname itself, so the address that
 * passed `resolvePublicAddresses` is not necessarily the one it connects to
 * (DNS rebinding). Here the socket is opened to a vetted address directly. The
 * original hostname is kept for TLS SNI / certificate verification and the Host
 * header, so a normal HTTPS receiver behind a name still validates.
 *
 * Several vetted addresses are tried in order, but ONLY when the TCP connect itself
 * fails (refused, unreachable, ...). Once connected, or on any HTTP response, there
 * is no second attempt: the receiver may already have seen the POST. Every candidate
 * was vetted by the caller; this module never adds one.
 *
 * Redirects are never followed: the response status is returned as-is and the
 * caller treats any 3xx as a failure. The response body is never read — the
 * socket is destroyed as soon as the headers arrive — so a hostile receiver
 * cannot make us buffer an unbounded body.
 *
 * `timeoutMs` is one deadline for the whole call, across all candidates.
 */

export interface PinnedPostRequest {
  readonly url: URL;
  /** Vetted addresses, in the order to try them. Never empty. */
  readonly addresses: readonly ResolvedAddress[];
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface PinnedPostResult {
  readonly status: number;
}

/** Injectable for tests; the service default is `pinnedPost`. */
export type WebhookTransport = (req: PinnedPostRequest) => Promise<PinnedPostResult>;

/** Errors that mean "could not open the socket to THIS address" — safe to try the next one. */
const CONNECT_ERRORS: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
]);

class ConnectFailure extends Error {
  constructor(override readonly cause: Error) {
    super(cause.message);
  }
}

function postOnce(req: PinnedPostRequest, address: ResolvedAddress, signal: AbortSignal): Promise<PinnedPostResult> {
  return new Promise<PinnedPostResult>((resolve, reject) => {
    const { url } = req;
    const secure = url.protocol === 'https:';
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const send = secure ? httpsRequest : httpRequest;
    let connected = false;
    const out = send(
      {
        // Connect to the vetted IP, not the name.
        host: address.address,
        family: address.family,
        port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        headers: { ...req.headers, host: url.host, 'content-length': String(Buffer.byteLength(req.body)) },
        // SNI + certificate name check use the original hostname (never an IP literal).
        ...(secure && isIP(hostname) === 0 ? { servername: hostname } : {}),
        // One socket per delivery: no pooled connection to an earlier address.
        agent: false,
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve({ status });
      },
    );
    out.on('socket', (socket) => {
      if (socket.connecting) socket.once('connect', () => (connected = true));
      else connected = true;
    });
    out.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code;
      if (!connected && !signal.aborted && code && CONNECT_ERRORS.has(code)) reject(new ConnectFailure(err));
      else reject(err);
    });
    out.end(req.body);
  });
}

export const pinnedPost: WebhookTransport = async (req) => {
  const signal = AbortSignal.timeout(req.timeoutMs);
  let last: Error | undefined;
  for (const address of req.addresses) {
    try {
      return await postOnce(req, address, signal);
    } catch (err) {
      if (!(err instanceof ConnectFailure)) throw err;
      last = err.cause;
    }
  }
  throw last ?? new Error('webhook_no_address');
};
