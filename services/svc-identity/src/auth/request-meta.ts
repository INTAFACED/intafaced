/**
 * What the device list shows about the request that opened or rotated a session. Set once per request
 * by the server hook, read when a session row is written. Missing means the value is stored as null.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIPv4, isIPv6 } from 'node:net';

export type RequestMeta = { readonly ip?: string | undefined; readonly userAgent?: string | undefined };

export const requestMetaAls = new AsyncLocalStorage<RequestMeta>();

const USER_AGENT_MAX = 400;

/** The request's user agent, trimmed and bounded, or null. */
export function currentUserAgent(): string | null {
  const raw = requestMetaAls.getStore()?.userAgent?.trim();
  return raw ? raw.slice(0, USER_AGENT_MAX) : null;
}

export function currentRequestIp(): string | null {
  return requestMetaAls.getStore()?.ip?.trim() || null;
}

/** The first three of eight groups of an IPv6 address, with `::` expanded; null when it is not an address. */
function ipv6Prefix(ip: string): string[] | null {
  if (!isIPv6(ip)) return null;
  const [head = '', tail, extra] = ip.split('::');
  if (extra !== undefined) return null;
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - front.length - back.length;
  if (fill < 0) return null;
  return [...front, ...Array<string>(fill).fill('0'), ...back].slice(0, 3);
}

/**
 * The list shows an address with its last part hidden: `203.0.113.x` for IPv4 (also when it comes
 * as `::ffff:203.0.113.7`), and the first three of eight groups for IPv6. Anything that is not an
 * address shows nothing.
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4 && isIPv4(ip.replace(/^::ffff:/i, ''))) return `${v4[1]}.x`;
  const prefix = ipv6Prefix(ip);
  return prefix ? `${prefix.join(':')}::x` : null;
}
