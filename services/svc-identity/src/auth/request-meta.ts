/**
 * What the device list shows about the request that opened or rotated a session. Set once per request
 * by the server hook, read when a session row is written. Missing means the value is stored as null.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

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

/**
 * The list shows an address with its last part hidden: `203.0.113.x` for IPv4, and the first three
 * groups for IPv6. Anything that is not an address shows nothing.
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.x`;
  if (ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip)) {
    const groups = ip.split(':').filter((group) => group !== '');
    return `${groups.slice(0, 3).join(':')}::x`;
  }
  return null;
}
