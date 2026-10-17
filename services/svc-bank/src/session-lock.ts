import type { Sql } from 'postgres';

/**
 * ONE SESSION ADVISORY LOCK, WITHOUT STARVING THE POOL THAT HOLDS IT.
 *
 * The money paths that need "one at a time per loan / per off-ramp" take a
 * session-level `pg_advisory_lock` and keep it from the claim, across the ledger
 * post, to the settle. A session lock belongs to ONE connection, so that
 * connection is reserved for the whole span and sits idle while `body()` runs
 * its own transactions on OTHER connections of the same pool.
 *
 * That is a deadlock waiting for its Nth caller. postgres.js waits for a free
 * connection with no timeout. When DATABASE_POOL_MAX such callers overlap, every
 * connection is a reserved, idle lock holder, no body can open its transaction,
 * and no body can finish to release its lock. The pool is frozen until restart.
 * (GitHub issue #4621.)
 *
 * WHY THE BODY IS NOT RUN ON THE RESERVED CONNECTION
 *
 * The bodies are the repay, liquidation and off-ramp paths: dozens of queries
 * and nested transactions written against `this.sql`. Re-pointing all of them at
 * one connection is a rewrite of the money paths, and a transaction cannot be
 * opened on a reserved connection through `sql.begin` at all. A transaction-level
 * lock (`pg_advisory_xact_lock`) has the same shape: the transaction's
 * connection sits idle while the body borrows others.
 *
 * WHAT THIS DOES INSTEAD
 *
 * It bounds how many connections lock holders may occupy to half the pool
 * (rounded down, at least one). The rest is always available to the bodies and
 * to every other request. A body only ever needs one connection at a time (no
 * transaction callback in this service touches the pool-level sql, which
 * `session-lock.guard.test.ts` pins), and every connection it borrows is
 * returned in bounded time, so a body can always get one: it cannot wait on a
 * connection that only other lock holders occupy. Callers past the cap wait on a
 * plain in-process queue HOLDING NO CONNECTION, which is the property that
 * matters.
 *
 * WHAT DID NOT CHANGE
 *
 * The lock itself: same `pg_advisory_lock(hashtext(namespace), hashtext(key))`,
 * same session scope, same unlock on the same connection, held for the same
 * span (acquired before the body, released after it, whatever the body throws).
 * A replica running the old code and a replica running this take the SAME
 * Postgres lock, so they exclude each other during a rolling deploy.
 *
 * MUST NOT NEST. A body that takes a second lock through this helper holds one
 * slot while queueing for another; with every slot doing that, none ever frees.
 * Loan repay and liquidation take both historical keys in one call on one
 * connection. They are not nested.
 */

type Gate = { capacity: number; active: number; waiting: Array<() => void> };

const gates = new WeakMap<object, Gate>();

/** How many lock-holding connections this pool may give out at once. */
export function sessionLockCapacity(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax / 2));
}

function gateFor(sql: Sql): Gate | null {
  const max = (sql as unknown as { options?: { max?: unknown } }).options?.max;
  // A stand-in without pool options (a unit-test double) has no pool to starve.
  if (typeof max !== 'number') return null;
  if (max < 2) {
    // One connection cannot be both the idle lock holder and the body's
    // connection. Refuse loudly: the alternative is a silent, permanent hang.
    throw new Error(`A session advisory lock needs DATABASE_POOL_MAX >= 2 (got ${max}): the body cannot borrow a connection`);
  }
  let gate = gates.get(sql);
  if (!gate) {
    gate = { capacity: sessionLockCapacity(max), active: 0, waiting: [] };
    gates.set(sql, gate);
  }
  return gate;
}

async function enter(gate: Gate): Promise<void> {
  if (gate.active < gate.capacity) {
    gate.active++;
    return;
  }
  // The slot is handed over by `leave`, so `active` stays counted for the next
  // caller and a late arrival cannot jump the queue.
  await new Promise<void>((resolve) => gate.waiting.push(resolve));
}

function leave(gate: Gate): void {
  const next = gate.waiting.shift();
  if (next) next();
  else gate.active--;
}

/**
 * Run `body` while holding `pg_advisory_lock(hashtext(namespace), hashtext(key))`
 * on a reserved connection of `sql`. Exclusive across every replica.
 */
export async function withSessionAdvisoryLock<T>(sql: Sql, namespace: string, key: string, body: () => Promise<T>): Promise<T> {
  return withSessionAdvisoryLocks(sql, [namespace], key, body);
}

/**
 * Hold each namespace on one reserved connection, in sorted order, for one gate
 * slot. Sorted order is what keeps two keys from deadlocking. An old replica
 * that still locks only one of those keys collides with this caller on that key.
 */
export async function withSessionAdvisoryLocks<T>(
  sql: Sql,
  namespaces: readonly string[],
  key: string,
  body: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(namespaces)].sort();
  if (ordered.length === 0) throw new Error('A session advisory lock needs a namespace');
  const gate = gateFor(sql);
  if (gate) await enter(gate);
  try {
    const reserved = await sql.reserve();
    const held: string[] = [];
    try {
      for (const namespace of ordered) {
        await reserved`SELECT pg_advisory_lock(hashtext(${namespace}), hashtext(${key}))`;
        held.push(namespace);
      }
      return await body();
    } finally {
      try {
        for (let i = held.length - 1; i >= 0; i--) {
          const namespace = held[i]!;
          await reserved`SELECT pg_advisory_unlock(hashtext(${namespace}), hashtext(${key}))`;
        }
      } finally {
        reserved.release();
      }
    }
  } finally {
    if (gate) leave(gate);
  }
}

/**
 * Try `pg_try_advisory_lock(hashtext(namespace), hashtext(key))`. Another
 * session already holding it returns `{ acquired: false }` without waiting,
 * so a second replica skips the pass instead of running it later.
 *
 * This does not take a gate slot. The recovery pass holds the lock on its own
 * one-connection client while the job bodies take loan locks on the main pool.
 * Putting both on the gate would nest: the pass would occupy a slot and then
 * wait for another, and a full gate would never free (the note at the top).
 */
export async function trySessionAdvisoryLock<T>(
  sql: Sql,
  namespace: string,
  key: string,
  body: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (namespace.trim() === '') throw new Error('A session advisory lock needs a namespace');
  const reserved = await sql.reserve();
  let held = false;
  try {
    const [row] = await reserved<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(hashtext(${namespace}), hashtext(${key})) AS locked
    `;
    if (row?.locked !== true) return { acquired: false };
    held = true;
    return { acquired: true, value: await body() };
  } finally {
    try {
      if (held) await reserved`SELECT pg_advisory_unlock(hashtext(${namespace}), hashtext(${key}))`;
    } finally {
      reserved.release();
    }
  }
}
