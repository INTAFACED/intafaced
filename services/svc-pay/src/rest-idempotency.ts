import { createHash, randomUUID } from 'node:crypto';

/**
 * HTTP Idempotency-Key journal for the merchant REST surface (ADR §2.2).
 *
 * Every mutating POST requires the header. A repeated key with an identical
 * request fingerprint returns the stored response; a repeated key with a
 * different fingerprint is a conflict — answering either way would be worse
 * than refusing.
 *
 * This is the HTTP-layer contract. Ledger / rail business keys underneath
 * stay whatever `payment-service` already uses; this store is what makes a
 * merchant retry safe before any of that runs twice.
 *
 * Ordering for Class M (same claim→put shape as crypto broadcasts):
 *   1. `claim` — exactly one concurrent caller may execute for (owner, key)
 *   2. run the handler
 *   3. `put` the response (or `abandon` on 5xx so a retry may try again)
 *
 * `MemoryRestIdempotencyStore` is single-process. Production multi-replica
 * MUST supply `PostgresRestIdempotencyStore`.
 */

export interface RestIdempotencyRecord {
  readonly statusCode: number;
  readonly body: unknown;
}

export type RestIdempotencyClaim =
  /**
   * This caller owns the claim and must run the handler. `token` identifies
   * THIS ownership — see `STALE_PENDING_MS` for why a claim needs identity.
   */
  | { readonly kind: 'mine'; readonly token: string }
  | { readonly kind: 'replay'; readonly record: RestIdempotencyRecord }
  | { readonly kind: 'conflict' };

export interface RestIdempotencyStore {
  /**
   * Reserve `(ownerId, key)` for this fingerprint, or return a prior result.
   * `conflict` means the key was already used for a different request.
   */
  claim(ownerId: string, key: string, fingerprint: string): Promise<RestIdempotencyClaim>;
  /**
   * Persist a completed response. Never overwrites a settled body, and never a
   * claim that is no longer ours — pass the `token` `claim` handed back.
   */
  put(ownerId: string, key: string, record: RestIdempotencyRecord, token: string): Promise<void>;
  /**
   * Drop a pending claim after a 5xx so a retry with the same key may execute.
   * Settled rows are left alone, and so is a claim now held by someone else.
   */
  abandon(ownerId: string, key: string, token: string): Promise<void>;
}

/** Canonical request fingerprint — method + path + body bytes, SHA-256 hex. */
export function fingerprintRequest(method: string, path: string, body: unknown): string {
  const payload = `${method.toUpperCase()}\n${path}\n${stableStringify(body)}`;
  return createHash('sha256').update(payload).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      // Ordinary assignment of `__proto__` invokes the prototype setter, so the
      // key is not an own property and JSON.stringify drops it. Two bodies that
      // differ only by that member would then share a fingerprint, and a
      // repeated Idempotency-Key would replay the stored response.
      Object.defineProperty(out, key, {
        value: sortKeys(obj[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

type PendingSlot = { fingerprint: string; waiters: Array<() => void>; token: string };
type SettledSlot = { fingerprint: string; record: RestIdempotencyRecord };

/** In-memory journal — unit tests and single-process local runners. */
export class MemoryRestIdempotencyStore implements RestIdempotencyStore {
  private readonly map = new Map<string, PendingSlot | SettledSlot>();

  async claim(ownerId: string, key: string, fingerprint: string): Promise<RestIdempotencyClaim> {
    const id = slotId(ownerId, key);
    for (;;) {
      const existing = this.map.get(id);
      if (existing && 'record' in existing) {
        if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
        return { kind: 'replay', record: existing.record };
      }
      if (existing && !('record' in existing)) {
        if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
        await new Promise<void>((resolve) => {
          existing.waiters.push(resolve);
        });
        // `put` settles this slot. `abandon` deletes it and wakes every
        // waiter. A woken waiter must look again: the key may be free to
        // take, a sibling may already hold the new claim, or a record may
        // be waiting to replay. Treating a missing record as stalled makes
        // a retry of the failed mutation throw.
        continue;
      }
      const token = randomUUID();
      this.map.set(id, { fingerprint, waiters: [], token });
      return { kind: 'mine', token };
    }
  }

  /** Token-gated for the same reason the Postgres store is — see its `put`. */
  async put(ownerId: string, key: string, record: RestIdempotencyRecord, token: string): Promise<void> {
    const id = slotId(ownerId, key);
    const existing = this.map.get(id);
    if (!existing || 'record' in existing) return;
    if (existing.token !== token) return;
    const { fingerprint, waiters } = existing;
    this.map.set(id, { fingerprint, record });
    for (const wake of waiters) wake();
  }

  async abandon(ownerId: string, key: string, token: string): Promise<void> {
    const id = slotId(ownerId, key);
    const existing = this.map.get(id);
    if (!existing || 'record' in existing) return;
    if (existing.token !== token) return;
    this.map.delete(id);
    for (const wake of existing.waiters) wake();
  }
}

export type RestIdempotencySql = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...values: any[]): Promise<readonly any[]>;
};

/**
 * How long a pending claim may sit before another caller may take it over.
 *
 * Deliberately far longer than any handler that is still alive. A mutating
 * request here talks to a rail and is bounded by the edge's upstream timeout,
 * measured in seconds; fifteen minutes is not a tuning knob, it is a margin so
 * wide that reclaiming a LIVE handler is not a scenario anyone has to reason
 * about. If a request really has been running fifteen minutes, every proxy
 * between the merchant and us abandoned it long ago.
 *
 * The cost of being wrong in each direction is asymmetric, which is why the
 * margin is lopsided:
 *
 *   · too SHORT — two callers run the same money handler concurrently. The
 *     service layer would mostly catch it (a state transition refuses, a refund
 *     carries its own business key) but "mostly" is not a thing to rely on.
 *   · too LONG  — a merchant waits longer before a wedged key frees itself.
 *
 * So: minutes, not seconds. And the token on `put`/`abandon` means even a
 * mistaken reclaim cannot let the dead handler's response overwrite the live
 * one's row.
 */
const STALE_PENDING_MS = 15 * 60 * 1000;

const DEFAULT_POLL_MS = 50;
const DEFAULT_MAX_WAITS = 200;

/**
 * Durable journal for multi-replica merchant REST mutations.
 * Pending rows use `status_code = 0` and an empty body until `put`.
 */
export class PostgresRestIdempotencyStore implements RestIdempotencyStore {
  constructor(
    private readonly sql: RestIdempotencySql,
    private readonly opts: { pollMs?: number; maxWaits?: number } = {},
  ) {}

  async claim(ownerId: string, key: string, fingerprint: string): Promise<RestIdempotencyClaim> {
    const inserted = (await this.sql`
      INSERT INTO pay.rest_idempotency (owner_id, idempotency_key, request_fingerprint, status_code, response_body)
      VALUES (${ownerId}, ${key}, ${fingerprint}, 0, ${null})
      ON CONFLICT (owner_id, idempotency_key) DO NOTHING
      RETURNING updated_at::text AS token
    `) as ReadonlyArray<{ token: string }>;
    if (inserted[0]) return { kind: 'mine', token: inserted[0].token };

    /**
     * RECLAIM A CLAIM WHOSE OWNER DIED.
     *
     * `abandon` covers a 5xx and a thrown handler. It does not cover the process
     * simply ceasing to exist — an OOM kill, a pod eviction, a deploy landing
     * mid-request. Then the pending row survives with nobody to settle it, and
     * every later retry of that key polls its whole budget and throws. The key
     * is wedged permanently, and retrying with the same key is the entire
     * purpose of an idempotency key. An ordinary deploy could do this.
     *
     * The index on `updated_at` in migration 0007 was put there for this and
     * nothing else; the reclaim was never written.
     *
     * FINGERPRINT FIRST, ALWAYS. A different request on the same key is a
     * conflict whether or not the row is stale, so reclaiming only ever hands
     * over a claim for the SAME request — which is what makes it safe to let a
     * second caller run the handler.
     *
     * The UPDATE re-checks `updated_at` after taking the row lock, so two
     * simultaneous reclaimers cannot both win: the loser's predicate is false
     * once the winner commits.
     */
    const reclaimed = (await this.sql`
      UPDATE pay.rest_idempotency
         SET updated_at = now()
       WHERE owner_id = ${ownerId}
         AND idempotency_key = ${key}
         AND request_fingerprint = ${fingerprint}
         AND status_code = 0
         AND updated_at < now() - ${`${STALE_PENDING_MS} milliseconds`}::interval
      RETURNING updated_at::text AS token
    `) as ReadonlyArray<{ token: string }>;
    if (reclaimed[0]) return { kind: 'mine', token: reclaimed[0].token };

    const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
    const maxWaits = this.opts.maxWaits ?? DEFAULT_MAX_WAITS;
    for (let i = 0; i < maxWaits; i++) {
      const rows = (await this.sql`
        SELECT request_fingerprint, status_code, response_body
        FROM pay.rest_idempotency
        WHERE owner_id = ${ownerId} AND idempotency_key = ${key}
      `) as ReadonlyArray<{
        request_fingerprint: string;
        status_code: number;
        response_body: unknown;
      }>;
      const row = rows[0];
      if (!row) {
        // Winner abandoned — try to claim again.
        return this.claim(ownerId, key, fingerprint);
      }
      if (row.request_fingerprint !== fingerprint) return { kind: 'conflict' };
      if (row.status_code !== 0) {
        return {
          kind: 'replay',
          record: { statusCode: row.status_code, body: row.response_body },
        };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`rest idempotency claim for ${ownerId}/${key} stalled while pending`);
  }

  /**
   * `AND updated_at::text = token` is the load-bearing clause.
   *
   * A handler that was declared dead and had its claim reclaimed can still be
   * alive — hung on a socket, about to return. Without the token it would
   * settle the row the NEW owner is holding, and the second caller would be
   * handed a response produced by an execution it knows nothing about. The
   * token makes the late write a no-op instead.
   */
  async put(ownerId: string, key: string, record: RestIdempotencyRecord, token: string): Promise<void> {
    // postgres.js serialises plain objects into jsonb. Only replace pending.
    await this.sql`
      UPDATE pay.rest_idempotency
      SET status_code = ${record.statusCode},
          response_body = ${record.body as never},
          updated_at = now()
      WHERE owner_id = ${ownerId}
        AND idempotency_key = ${key}
        AND status_code = 0
        AND updated_at::text = ${token}
    `;
  }

  async abandon(ownerId: string, key: string, token: string): Promise<void> {
    await this.sql`
      DELETE FROM pay.rest_idempotency
      WHERE owner_id = ${ownerId}
        AND idempotency_key = ${key}
        AND status_code = 0
        AND updated_at::text = ${token}
    `;
  }
}

function slotId(ownerId: string, key: string): string {
  return `${ownerId}\0${key}`;
}
