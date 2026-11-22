/**
 * Operator door onto the two protocol adapters' own status (J-cex-spot-20 #3, SP-order-02): svc-fix's FIX sessions and
 * CompID to account map, and svc-ws's SBE tape consumers. A read for the founder console, `admin:read`.
 *
 * Each adapter is read on its own, signed as `svc-edge` with that adapter's dedicated read key (`FIX_STATUS_READ_SECRET`,
 * `WS_STATUS_READ_SECRET`), never a fleet secret: the edge holds none. A blank URL or key leaves that half refused by name,
 * and the other half still reads. Only the named fields go on, so nothing an adapter might add (and no balance, margin
 * or Greeks: neither adapter holds one) reaches the console through here. Each half is called through its record
 * (`FIX_ADAPTER_STATUS`, `WS_SBE_CONSUMERS`), which names its path and parses its reply.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError, bearerToken, requireScope, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { serviceCallSigner } from '@intafaced/contracts/service-auth-http';
import { FIX_ADAPTER_STATUS } from '@intafaced/contracts/fix-procedures';
import { callHttpRecord } from '@intafaced/contracts/procedure-http';
import type { HttpTransport, ProcedureRecord } from '@intafaced/contracts/procedure';
import { sbeConsumerSchema, WS_SBE_CONSUMERS } from '@intafaced/contracts/ws-procedures';
import { z } from 'zod';
import { statusForAuthError } from './admin-api.js';
import type { EdgeS2s } from './s2s.js';

export const ADAPTER_STATUS_EDGE_PATH = '/admin/trade-ops/adapters/status';

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

const jsonOrNull = (text: string): unknown => {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
};

/** A read that never reached an answer: past the timeout is unknown, anything else unavailable. */
function unanswered(err: unknown, service: string, timeoutMs: number): AdapterRead {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError')
    return { kind: 'unknown', error: `${service} did not answer before ${timeoutMs}ms` };
  return { kind: 'unavailable', error: `${service} did not answer: ${err instanceof Error ? err.message : String(err)}` };
}

/** An adapter's refusal, as `callHttpRecord` hands it back: its status and its body as sent. */
class AdapterRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`adapter answered ${status}`);
  }
}

/**
 * One adapter's status through its record, signed as svc-edge with that adapter's own read key. A refusal comes back
 * answered with its status and body; a reply the record does not parse comes back with no body, so it reads as unreadable.
 */
export function recordStatusRead(
  record: ProcedureRecord & HttpTransport & { readonly service: 'svc-fix' | 'svc-ws' },
  options: {
    readonly baseUrl: string;
    readonly secret: string;
    readonly timeoutMs: number;
    readonly fetchFn?: typeof fetch;
    readonly s2s?: EdgeS2s | undefined;
  },
): AdapterStatusRead {
  const { baseUrl, secret, timeoutMs, s2s, fetchFn = globalThis.fetch } = options;
  const sign = serviceCallSigner({ service: 'svc-edge', audience: record.service, legacySecret: secret, s2s });
  const fetcher: typeof fetch = (input, init) => fetchFn(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return async () => {
    try {
      const body: unknown = await callHttpRecord(record, {
        baseUrl,
        input: undefined,
        sign,
        errorOf: (_path, status, detail) => new AdapterRefused(status, jsonOrNull(detail)),
        fetcher,
      });
      return { kind: 'answered', status: 200, body };
    } catch (err) {
      if (err instanceof AdapterRefused) return { kind: 'answered', status: err.status, body: err.body };
      // A 2xx whose body is not JSON, or not the record's shape: answered, with nothing readable.
      if (err instanceof z.ZodError || err instanceof SyntaxError) return { kind: 'answered', status: 200, body: null };
      return unanswered(err, record.service, timeoutMs);
    }
  };
}

/** The read when both halves of the configuration are set, else the block naming the first blank key. */
export function adapterRead(
  url: string | undefined,
  secret: string | undefined,
  spec: {
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
  return recordStatusRead(spec.service === 'svc-ws' ? WS_SBE_CONSUMERS : FIX_ADAPTER_STATUS, { baseUrl: url, secret, timeoutMs, s2s });
}

export type FixSession = z.output<typeof FIX_ADAPTER_STATUS.output>['sessions'][number];

/** svc-fix's reply by its record, named fields only (anything else svc-fix sends is dropped by the parse). */
export function parseFixStatus(raw: unknown): z.output<typeof FIX_ADAPTER_STATUS.output> | null {
  const read = FIX_ADAPTER_STATUS.output.safeParse(raw);
  return read.success ? read.data : null;
}

export type SbeConsumer = z.output<typeof sbeConsumerSchema>;

/** svc-ws's reply by its record, named fields only (`service` is the record's own literal and is not passed on). */
export function parseSbeStatus(raw: unknown): { codecLinked: boolean; consumers: SbeConsumer[]; asOf: string } | null {
  const read = WS_SBE_CONSUMERS.output.safeParse(raw);
  if (!read.success) return null;
  const { codecLinked, consumers, asOf } = read.data;
  return { codecLinked, consumers, asOf };
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
