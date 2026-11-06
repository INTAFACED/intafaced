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
import { AuthError, bearerToken, requireScope, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { serviceCallSigner } from '@intafaced/contracts';
import { statusForAuthError } from './admin-api.js';
import type { EdgeS2s } from './s2s.js';

export const ADAPTER_STATUS_EDGE_PATH = '/admin/trade-ops/adapters/status';
export const FIX_STATUS_UPSTREAM_PATH = '/internal/status';
export const SBE_STATUS_UPSTREAM_PATH = '/internal/sbe/consumers';

export type AdapterRead =
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unknown'; readonly error: string }
  | { readonly kind: 'unavailable'; readonly error: string };

/** One adapter's status read. It can only ever GET the one path it was made for. */
export type AdapterStatusRead = () => Promise<AdapterRead>;

export interface AdapterBlock {
  readonly code: 'fix_status_unconfigured' | 'ws_status_unconfigured';
  readonly key: 'FIX_STATUS_URL' | 'FIX_STATUS_READ_SECRET' | 'WS_STATUS_URL' | 'WS_STATUS_READ_SECRET';
}

export interface AdapterStatusDeps {
  readonly tokens: TokenConfig;
  readonly sessionLive?: (principal: Principal) => Promise<void>;
  readonly fix: AdapterStatusRead | AdapterBlock;
  readonly sbe: AdapterStatusRead | AdapterBlock;
  readonly now?: () => number;
}

/** A signed GET of exactly `${baseUrl}${path}`, as svc-edge, with the adapter's own read key. */
export function httpAdapterStatusRead(
  baseUrl: string,
  path: string,
  secret: string,
  timeoutMs: number,
  service: 'svc-fix' | 'svc-ws',
  fetchFn: typeof fetch = globalThis.fetch,
  s2s?: EdgeS2s,
): AdapterStatusRead {
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
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        return { kind: 'unknown', error: `${service} did not answer before ${timeoutMs}ms` };
      return { kind: 'unavailable', error: `${service} did not answer: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

/** The read when both halves of the configuration are set, else the block naming the first blank key. */
export function adapterRead(
  url: string | undefined,
  secret: string | undefined,
  spec: {
    readonly path: string;
    readonly service: 'svc-fix' | 'svc-ws';
    readonly code: AdapterBlock['code'];
    readonly urlKey: AdapterBlock['key'];
    readonly secretKey: AdapterBlock['key'];
  },
  timeoutMs: number,
  s2s?: EdgeS2s,
): AdapterStatusRead | AdapterBlock {
  if (!url) return { code: spec.code, key: spec.urlKey };
  if (!secret) return { code: spec.code, key: spec.secretKey };
  return httpAdapterStatusRead(url, spec.path, secret, timeoutMs, spec.service, undefined, s2s);
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export interface FixSession {
  readonly role: 'order-entry' | 'drop-copy';
  readonly beginString: string;
  readonly senderCompId: string;
  readonly targetCompId: string;
  readonly state: string;
  readonly accountId: string | null;
  /** Null when the FIX engine could not read its store. */
  readonly nextSenderSeq: number | null;
  readonly nextTargetSeq: number | null;
}

export function parseFixStatus(raw: unknown): {
  sessions: FixSession[];
  compIdMapSet: boolean;
  compIdMap: { compId: string; accountId: string }[];
  asOf: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.sessions) || !Array.isArray(r.compIdMap) || typeof r.compIdMapSet !== 'boolean' || !isText(r.asOf)) return null;
  const sessions: FixSession[] = [];
  for (const s of r.sessions as unknown[]) {
    if (!s || typeof s !== 'object') return null;
    const x = s as Record<string, unknown>;
    if (x.role !== 'order-entry' && x.role !== 'drop-copy') return null;
    if (!isText(x.beginString) || !isText(x.senderCompId) || !isText(x.targetCompId) || !isText(x.state)) return null;
    if (
      !(x.accountId === null || isText(x.accountId)) ||
      !(x.nextSenderSeq === null || isCount(x.nextSenderSeq)) ||
      !(x.nextTargetSeq === null || isCount(x.nextTargetSeq))
    )
      return null;
    sessions.push({
      role: x.role,
      beginString: x.beginString,
      senderCompId: x.senderCompId,
      targetCompId: x.targetCompId,
      state: x.state,
      accountId: x.accountId,
      nextSenderSeq: x.nextSenderSeq,
      nextTargetSeq: x.nextTargetSeq,
    });
  }
  const compIdMap: { compId: string; accountId: string }[] = [];
  for (const m of r.compIdMap as unknown[]) {
    const x = m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
    if (!x || !isText(x.compId) || !isText(x.accountId)) return null;
    compIdMap.push({ compId: x.compId, accountId: x.accountId });
  }
  return { sessions, compIdMapSet: r.compIdMapSet, compIdMap, asOf: r.asOf };
}

export interface SbeConsumer {
  readonly id: string;
  readonly marketId: string;
  readonly connectedAt: string;
  readonly framesSent: number;
  readonly lastSequence: string | null;
}

export function parseSbeStatus(raw: unknown): { codecLinked: boolean; consumers: SbeConsumer[]; asOf: string } | null {
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

type Half<T> =
  | ({ readonly read: 'ok' } & T)
  | { readonly read: 'refused'; readonly code: string; readonly error: string; readonly key?: string }
  | { readonly read: 'unknown'; readonly code: string; readonly error: string };

async function readHalf<T>(source: AdapterStatusRead | AdapterBlock, service: string, parse: (raw: unknown) => T | null): Promise<Half<T>> {
  if (typeof source !== 'function') {
    return {
      read: 'refused',
      code: source.code,
      key: source.key,
      error: `${source.key} is unpublished. This edge does not read ${service} without it.`,
    };
  }
  const res = await source();
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
    const [fix, sbe] = await Promise.all([readHalf(deps.fix, 'svc-fix', parseFixStatus), readHalf(deps.sbe, 'svc-ws', parseSbeStatus)]);
    return reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({ fix, sbe, asOf: new Date(clock()).toISOString() });
  });
}
