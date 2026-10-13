import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ResolvedAddress } from './webhook-url-guard.js';

/**
 * One webhook POST to an address that was already vetted.
 *
 * `fetch` cannot be used: it resolves the hostname itself, so the address that
 * passed `resolvePublicAddress` is not necessarily the one it connects to
 * (DNS rebinding). Here the socket is opened to `address` directly. The original
 * hostname is kept for TLS SNI / certificate verification and the Host header,
 * so a normal HTTPS receiver behind a name still validates.
 *
 * Redirects are never followed: the response status is returned as-is and the
 * caller treats any 3xx as a failure. The response body is never read — the
 * socket is destroyed as soon as the headers arrive — so a hostile receiver
 * cannot make us buffer an unbounded body.
 */

export interface PinnedPostRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface PinnedPostResult {
  readonly status: number;
}

/** Injectable for tests; the service default is `pinnedPost`. */
export type WebhookTransport = (req: PinnedPostRequest) => Promise<PinnedPostResult>;

export const pinnedPost: WebhookTransport = (req) =>
  new Promise<PinnedPostResult>((resolve, reject) => {
    const { url, address } = req;
    const secure = url.protocol === 'https:';
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const send = secure ? httpsRequest : httpRequest;
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
        signal: AbortSignal.timeout(req.timeoutMs),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve({ status });
      },
    );
    out.on('error', reject);
    out.end(req.body);
  });
