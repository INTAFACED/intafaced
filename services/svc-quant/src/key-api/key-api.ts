import { createHash } from 'node:crypto';
import { TRPCError, type Context } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import {
  QUANT_DATABASE_URL_UNSET,
  QUANT_IDEMPOTENCY_KEY_INVALID,
  QUANT_IDEMPOTENCY_KEY_REQUIRED,
  QUANT_IDEMPOTENCY_KEY_REUSED,
  QUANT_KEY_NO_SUCH_ENDPOINT,
  QuantError,
} from '../errors.js';

/**
 * The strategy API (J-algo-dev-14; DEFINITIVE_BUILD section 29, Code SDK): what an API key may call on svc-quant.
 *
 * A signed-in session reaches every procedure, as the screens do. A key (a principal with `kid`) reaches only the
 * procedures named here, each under its scope: list and read projects, backtests and reports with `quant:read`; start a
 * backtest with `quant:run`. Every other procedure answers a key `quant.key_no_such_endpoint`, so a key can't deploy,
 * edit, share or publish a strategy: those stay on the screen, where the person and their wallet act. Stopping a live
 * strategy by key is the trade door's `/api/v1/quant/live-runs/:id/stop` under `trade:write`, the screen's own route.
 */
type Principal = NonNullable<Context['principal']>;
type KeyScope = 'quant:read' | 'quant:run';

export const QUANT_KEY_API: Readonly<Record<string, KeyScope>> = {
  'studio.list': 'quant:read',
  'studio.get': 'quant:read',
  'backtest.history': 'quant:read',
  'backtest.result': 'quant:read',
  'backtest.report': 'quant:read',
  'backtest.start': 'quant:run',
};

/** The published reference a refusal points at. A fixed path: it names no account. */
export const QUANT_KEY_API_DOCS = '/developers/quant' as const;

/** 1 to 128 printable ASCII characters, as the trade door takes an `Idempotency-Key`. */
const KEY_SHAPE = /^[\x21-\x7e]{1,128}$/;

/**
 * Refuses a key's call before any procedure runs: a procedure outside the strategy API is not found, and one inside it
 * needs its scope. A session, a service caller or a signed-out caller passes untouched; each procedure still checks
 * its own caller. Throws the refusal; returns nothing.
 */
export function refuseKeyCall(principal: Principal | null, paths: readonly string[]): void {
  if (!principal?.kid) return;
  for (const path of paths) {
    const scope = QUANT_KEY_API[path];
    if (!scope) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `${path} is not in the strategy API; an API key can't call it (see ${QUANT_KEY_API_DOCS})`,
        cause: new QuantError(QUANT_KEY_NO_SUCH_ENDPOINT, `${path} — no such endpoint for an API key`),
      });
    }
    // A quant scope grants only itself: `quant:run` never implies `quant:read` (packages/auth scopes.ts).
    if (!principal.scopes.includes(scope)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Scope "${scope}" is required for ${path}`,
        cause: Object.assign(new Error(`Scope "${scope}" is required`), { code: 'scope.denied', docs: QUANT_KEY_API_DOCS }),
      });
    }
  }
}

/** svc-quant's context: Edge's, plus the `Idempotency-Key` header the caller sent, if any. */
export type QuantContext = Context & { readonly idempotencyKeyHeader?: string | null };

/** The `Idempotency-Key` header of a request, as one string or null. */
export function idempotencyKeyHeaderOf(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

export interface KeyIdempotencyRepository {
  /**
   * Stores `requestHash` under (account, key) unless a row is there already, and returns the hash that is stored: the
   * new one, or the one an earlier request stored.
   */
  claim(input: { readonly accountId: string; readonly key: string; readonly requestHash: string; readonly at: Date }): Promise<string>;
}

export function createMemoryKeyIdempotencyRepository(): KeyIdempotencyRepository {
  const rows = new Map<string, string>();
  return {
    async claim({ accountId, key, requestHash }) {
      const id = `${accountId}\u0000${key}`;
      if (!rows.has(id)) rows.set(id, requestHash);
      return rows.get(id)!;
    },
  };
}

export function createPostgresKeyIdempotencyRepository(sql: Sql): KeyIdempotencyRepository {
  return {
    async claim({ accountId, key, requestHash, at }) {
      await sql`
        INSERT INTO quant.api_idempotency (account_id, idempotency_key, request_hash, created_at)
        VALUES (${accountId}, ${key}, ${requestHash}, ${at})
        ON CONFLICT (account_id, idempotency_key) DO NOTHING`;
      const [row] = await sql<{ request_hash: string }[]>`
        SELECT request_hash FROM quant.api_idempotency WHERE account_id = ${accountId} AND idempotency_key = ${key}`;
      if (!row) throw new Error('quant.api_idempotency: the claimed row is missing');
      return row.request_hash;
    },
  };
}

/** A store that refuses by name: svc-quant has no database. */
export function refusingKeyIdempotencyRepository(): KeyIdempotencyRepository {
  return {
    async claim() {
      throw new QuantError(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset');
    },
  };
}

/** JSON with object keys sorted, so the same request hashes the same whatever order its fields came in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A key's backtest start under its `Idempotency-Key`. A key must send one; the first request stores the key with a hash
 * of what it asked for. The same key again with the same request goes on (and reads back the one stored run, whose key
 * the service derives from the same inputs); the same key with a different request refuses
 * `quant.idempotency_key_reused` and runs nothing. A session needs no header: the screen's Run is idempotent by its
 * inputs alone.
 */
export async function claimKeyIdempotency(
  ctx: QuantContext,
  accountId: string,
  procedure: string,
  input: unknown,
  store: KeyIdempotencyRepository,
  at: Date,
): Promise<void> {
  if (!ctx.principal?.kid) return;
  const key = ctx.idempotencyKeyHeader;
  if (key === null || key === undefined || key === '') {
    throw new QuantError(QUANT_IDEMPOTENCY_KEY_REQUIRED, 'Idempotency-Key — an API key must send one to start a backtest');
  }
  if (!KEY_SHAPE.test(key)) {
    throw new QuantError(QUANT_IDEMPOTENCY_KEY_INVALID, 'Idempotency-Key — 1 to 128 printable characters, no spaces');
  }
  const requestHash = createHash('sha256')
    .update(`${procedure}\n${canonical(input)}`)
    .digest('hex');
  const stored = await store.claim({ accountId, key, requestHash, at });
  if (stored !== requestHash) {
    throw new QuantError(QUANT_IDEMPOTENCY_KEY_REUSED, 'Idempotency-Key — this key was used for a different request; nothing was run');
  }
}

/** The store on svc-quant's own database. No URL or no pool size: every key's backtest start refuses by name. */
export function openKeyIdempotencyRepository(
  env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined },
  connect: (url: string, max: number) => Sql,
): { repository: KeyIdempotencyRepository; close: () => Promise<void> } {
  const url = env.DATABASE_URL?.trim();
  const pool = Number(env.DATABASE_POOL_MAX?.trim() ?? '');
  if (!url || !Number.isInteger(pool) || pool < 1 || pool > 200) {
    return { repository: refusingKeyIdempotencyRepository(), close: async () => undefined };
  }
  const sql = connect(url, pool);
  return { repository: createPostgresKeyIdempotencyRepository(sql), close: () => sql.end({ timeout: 5 }) };
}
