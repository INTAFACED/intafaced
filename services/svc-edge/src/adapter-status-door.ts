/**
 * Operator door onto the two protocol adapters' own status (J-cex-spot-20 #3, SP-order-02): svc-fix's FIX sessions and
 * CompID to account map, and svc-ws's SBE tape consumers. A read for the founder console, `admin:read`.
 *
 * Each adapter is read on its own, signed as `svc-edge` with that adapter's dedicated read key (`FIX_STATUS_READ_SECRET`,
 * `WS_STATUS_READ_SECRET`), never a fleet secret: the edge holds none. A blank URL or key leaves that half refused by name,
 * and the other half still reads. Only the named fields go on, so nothing an adapter might add (and no balance, margin
 * or Greeks: neither adapter holds one) reaches the console through here.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuthError, bearerToken, requireScope, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { serviceCallSigner } from '@intafaced/contracts';
import { FIX_ADAPTER_STATUS } from '@intafaced/contracts/fix-procedures';
import { callHttpRecord } from '@intafaced/contracts/procedure-http';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { statusForAuthError } from './admin-api.js';
import type { EdgeS2s } from './s2s.js';

export const ADAPTER_STATUS_EDGE_PATH = '/admin/trade-ops/adapters/status';
export const SBE_STATUS_UPSTREAM_PATH = '/internal/sbe/consumers';

export type AdapterRead =
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unknown'; readonly error: string }
  | { readonly kind: 'unavailable'; readonly error: string };

/** One adapter's status read, as the console shows that half. It can only ever GET the one path it was made for. */
export type AdapterStatusRead<T> = () => Promise<Half<T>>;

export interface AdapterBlock {
  readonly code: 'fix_status_unconfigured' | 'ws_status_unconfigured';
  readonly key: 'FIX_STATUS_URL' | 'FIX_STATUS_READ_SECRET' | 'WS_STATUS_URL' | 'WS_STATUS_READ_SECRET';
}

export interface AdapterStatusDeps {
  readonly tokens: TokenConfig;
  readonly sessionLive?: (principal: Principal) => Promise<void>;
  readonly fix: AdapterStatusRead<FixStatus> | AdapterBlock;
  readonly sbe: AdapterStatusRead<SbeStatus> | AdapterBlock;
  readonly now?: () => number;
}

/** A signed GET of exactly `${baseUrl}${path}`, as svc-edge, with svc-ws's own read key. */
export function httpAdapterStatusRead(
  baseUrl: string,
  path: string,
  secret: string,
  timeoutMs: number,
  service: 'svc-ws',
  fetchFn: typeof fetch = globalThis.fetch,
  s2s?: EdgeS2s,
): () => Promise<AdapterRead> {
  const target = `${baseUrl.replace(/\/$/, '')}${path}`;
  // The adapter's read key signs the body digest; with S2S on, the edge's own key also signs method, path and audience.
  const sign = serviceCallSigner({ service: 'svc-edge', audience: service, legacySecret: secret, s2s });
  return async () => {
    try {
      const res = await fetchFn(target, {
        method: 'GET',
        headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }
      return { kind: 'answered', status: res.status, body };
    } catch (err) {
      return noAnswer(err, service, timeoutMs);
    }
  };
}

function noAnswer(err: unknown, service: string, timeoutMs: number): Extract<AdapterRead, { kind: 'unknown' | 'unavailable' }> {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError')
    return { kind: 'unknown', error: `${service} did not answer before ${timeoutMs}ms` };
  return { kind: 'unavailable', error: `${service} did not answer: ${err instanceof Error ? err.message : String(err)}` };
}

/** svc-fix's refusal, with its status and its `{ error: { code, message } }` body as sent. */
class FixRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`svc-fix answered ${status}`);
  }
}

/** Where an adapter is, the key its status is read with, and how long to wait. */
export interface AdapterReadConfig {
  readonly timeoutMs: number;
  readonly s2s?: EdgeS2s | undefined;
}
interface FixReadConfig extends AdapterReadConfig {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetcher?: typeof fetch;
}

/** svc-fix's status read through its record (`fix.adapterStatus`), signed as svc-edge with the FIX status read key. */
export function fixStatusRead({
  baseUrl,
  secret,
  timeoutMs,
  s2s,
  fetcher = globalThis.fetch,
}: FixReadConfig): AdapterStatusRead<FixStatus> {
  const sign = serviceCallSigner({ service: 'svc-edge', audience: 'svc-fix', legacySecret: secret, s2s });
  return async () => {
    try {
      const status = await callHttpRecord(FIX_ADAPTER_STATUS, {
        baseUrl,
        input: undefined,
        sign,
        fetcher,
        timeoutMs,
        errorOf: (_path, code, detail) => new FixRefused(code, jsonOrNull(detail)),
      });
      return { read: 'ok', ...status };
    } catch (err) {
      if (err instanceof FixRefused) return toHalf({ kind: 'answered', status: err.status, body: err.body }, 'svc-fix', () => null);
      // A 2xx that is not JSON, or not the record's shape.
      if (err instanceof SyntaxError || err instanceof z.ZodError)
        return toHalf({ kind: 'answered', status: 200, body: null }, 'svc-fix', () => null);
      return toHalf(noAnswer(err, 'svc-fix', timeoutMs), 'svc-fix', () => null);
    }
  };
}

function jsonOrNull(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** svc-fix's read when both halves of its configuration are set, else the block naming the first blank key. */
export function fixAdapterRead(
  url: string | undefined,
  secret: string | undefined,
  config: AdapterReadConfig,
): AdapterStatusRead<FixStatus> | AdapterBlock {
  if (!url) return { code: 'fix_status_unconfigured', key: 'FIX_STATUS_URL' };
  if (!secret) return { code: 'fix_status_unconfigured', key: 'FIX_STATUS_READ_SECRET' };
  return fixStatusRead({ ...config, baseUrl: url, secret });
}

/** svc-ws's read when both halves of its configuration are set, else the block naming the first blank key. */
export function sbeAdapterRead(
  url: string | undefined,
  secret: string | undefined,
  { timeoutMs, s2s }: AdapterReadConfig,
): AdapterStatusRead<SbeStatus> | AdapterBlock {
  if (!url) return { code: 'ws_status_unconfigured', key: 'WS_STATUS_URL' };
  if (!secret) return { code: 'ws_status_unconfigured', key: 'WS_STATUS_READ_SECRET' };
  const read = httpAdapterStatusRead(url, SBE_STATUS_UPSTREAM_PATH, secret, timeoutMs, 'svc-ws', undefined, s2s);
  return async () => toHalf(await read(), 'svc-ws', parseSbeStatus);
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** What the console reads of svc-fix: the record's reply, its named fields only. */
export type FixStatus = ProcedureOutput<typeof FIX_ADAPTER_STATUS>;
export type FixSession = FixStatus['sessions'][number];

export interface SbeConsumer {
  readonly id: string;
  readonly marketId: string;
  readonly connectedAt: string;
  readonly framesSent: number;
  readonly lastSequence: string | null;
}

export interface SbeStatus {
  readonly codecLinked: boolean;
  readonly consumers: SbeConsumer[];
  readonly asOf: string;
}

export function parseSbeStatus(raw: unknown): SbeStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.codecLinked !== 'boolean' || !Array.isArray(r.consumers) || !isText(r.asOf)) return null;
  const consumers: SbeConsumer[] = [];
  for (const c of r.consumers as unknown[]) {
    const x = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    if (!x || !isText(x.id) || !isText(x.marketId) || !isText(x.connectedAt) || !isCount(x.framesSent)) return null;
    if (!(x.lastSequence === null || isText(x.lastSequence))) return null;
    consumers.push({ id: x.id, marketId: x.marketId, connectedAt: x.connectedAt, framesSent: x.framesSent, lastSequence: x.lastSequence });
  }
  return { codecLinked: r.codecLinked, consumers, asOf: r.asOf };
}

export type Half<T> =
  | ({ readonly read: 'ok' } & T)
  | { readonly read: 'refused'; readonly code: string; readonly error: string; readonly key?: string }
  | { readonly read: 'unknown'; readonly code: string; readonly error: string };

/** One adapter's answer as the console shows it: refused by name, unknown, or its parsed status. */
function toHalf<T>(res: AdapterRead, service: string, parse: (raw: unknown) => T | null): Half<T> {
  if (res.kind === 'unknown') return { read: 'unknown', code: 'adapter_status_unknown', error: res.error };
  if (res.kind === 'unavailable') return { read: 'refused', code: 'adapter_status_unavailable', error: res.error };
  if (res.status < 200 || res.status >= 300) {
    const err = (res.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    return {
      read: 'refused',
      code: typeof err?.code === 'string' ? err.code : 'adapter_status_unavailable',
      error: typeof err?.message === 'string' ? err.message : `${service} answered ${res.status}`,
    };
  }
  const parsed = parse(res.body);
  if (!parsed) return { read: 'refused', code: 'adapter_status_unreadable', error: `${service} status was not the expected shape` };
  return { read: 'ok', ...parsed };
}

async function readHalf<T>(source: AdapterStatusRead<T> | AdapterBlock, service: string): Promise<Half<T>> {
  if (typeof source !== 'function') {
    return {
      read: 'refused',
      code: source.code,
      key: source.key,
      error: `${source.key} is unpublished. This edge does not read ${service} without it.`,
    };
  }
  return source();
}

export function registerAdapterStatusRoute(app: FastifyInstance, deps: AdapterStatusDeps): void {
  const clock = deps.now ?? Date.now;
  const authError = (err: unknown, reply: FastifyReply): boolean => {
    if (err instanceof AuthError) {
      void reply.code(statusForAuthError(err)).header('cache-control', 'no-store').send({ error: err.message, code: err.code });
      return true;
    }
    return false;
  };

  app.get(ADAPTER_STATUS_EDGE_PATH, async (req, reply) => {
    try {
      const token = bearerToken(req.headers.authorization ?? null);
      if (!token) throw new AuthError('An operator token is required', 'token.invalid');
      const principal = await verifyAccessToken(token, deps.tokens);
      requireScope(principal, 'admin:read');
      if (deps.sessionLive) await deps.sessionLive(principal);
    } catch (err) {
      if (authError(err, reply)) return reply;
      throw err;
    }
    const [fix, sbe] = await Promise.all([readHalf(deps.fix, 'svc-fix'), readHalf(deps.sbe, 'svc-ws')]);
    return reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({ fix, sbe, asOf: new Date(clock()).toISOString() });
  });
}
