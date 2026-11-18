/**
 * Idempotent outbound broadcast journal.
 *
 * `ChainSendRequest.idempotencyKey` must never produce a second spend. DIRECTION
 * §3.1 / D26-P1-P9: the signed raw transaction is persisted before
 * eth_sendRawTransaction so a crash mid-broadcast resumes the same bytes.
 *
 * Ordering for Class M:
 *   1. `claim` — exactly one caller may sign for a key (`mine`), or resume
 *      a persisted signed payload (`resume`), or converge on a hash (`done`)
 *   2. `putSigned` — journal signed raw **before** any broadcast RPC
 *   3. `eth_sendRawTransaction` (identical bytes on resume)
 *   4. `put` the returned hash **before** waiting for the receipt
 *   5. wait for receipt (retryable; hash already journalled)
 *
 * The port talks to this interface, not to Postgres, so the conformance suite
 * and unit tests can use the in-memory implementation. Production multi-replica
 * MUST supply a durable store — `MemoryBroadcastStore` is single-process only.
 */

/** Sentinel while a worker owns the right to broadcast but has not yet put a hash. */
export const BROADCAST_PENDING = '__pending__' as const;

/**
 * Sentinel for a key a status query answered `not_sent` (PayoutQuery.tla, NeverPaidTwice): a reconciler gives the held
 * money back on that answer, so no send may ever leave under the key afterwards.
 */
export const BROADCAST_CLOSED = '__closed__' as const;

export type ClaimResult =
  | { readonly kind: 'mine' }
  | { readonly kind: 'done'; readonly txHash: string }
  | { readonly kind: 'resume'; readonly signedRaw: string }
  | { readonly kind: 'closed' };

const MINT: unique symbol = Symbol('KeyClosed');
/**
 * Proof that `BroadcastStore.close` took the key: nothing was or ever will be sent under it. Only this module can make
 * one (its constructor needs a token nothing else holds), and a chain port's `not_sent` answer (`ChainSendLookup`)
 * carries it, so a port cannot answer `not_sent` without closing the key first: a `not_sent` that left the key open
 * would let a send still leave after its money was given back.
 */
export class KeyClosed {
  readonly #minted = true;
  constructor(
    token: typeof MINT,
    readonly closedKey: string,
  ) {
    if (token !== MINT || !this.#minted) throw new Error('KeyClosed is made only by BroadcastStore.close');
  }
}
const keyClosed = (idempotencyKey: string): KeyClosed => new KeyClosed(MINT, idempotencyKey);

/**
 * `KeyClosed`: nothing was or will ever be sent under the key. `held`: a send has journalled signed bytes under the key,
 * or its hash has landed, so it may have left.
 */
export type CloseResult = KeyClosed | 'held';

const isHash = (v: string | null | undefined): v is string => Boolean(v) && v !== BROADCAST_PENDING && v !== BROADCAST_CLOSED;

export interface BroadcastStore {
  /** Prior txHash for this business key, or null if never completed. */
  get(idempotencyKey: string): Promise<string | null>;
  /**
   * Atomically reserve the key for broadcast. Exactly one concurrent caller
   * receives `mine` for a fresh key; callers that find a persisted signed raw
   * with no hash yet receive `resume`; others receive `done` once a hash lands.
   */
  claim(idempotencyKey: string): Promise<ClaimResult>;
  /**
   * Persist signed raw bytes before broadcast. Refuses to overwrite a different
   * signed payload for the same key. No-op (idempotent) when the same bytes
   * are already stored.
   */
  putSigned(idempotencyKey: string, signedRaw: string): Promise<void>;
  /**
   * Record a broadcast. If the key already holds a real hash, leave it and
   * return it — never overwrite. Pending sentinels are replaced by the hash.
   */
  put(idempotencyKey: string, txHash: string): Promise<string>;
  /** True once signed raw is journalled (resume-able). Required before RPC. */
  hasSigned(idempotencyKey: string): Promise<boolean>;
  /**
   * Close the key for a `not_sent` answer. A fresh key is taken with the same atomic insert `claim` uses; a key a send
   * has claimed but not yet journalled signed bytes for is taken from it, so a sender that died or whose signer threw
   * there leaves no claim nothing could ever answer. Either way every later `claim` answers `closed` and `putSigned`
   * refuses, so nothing is sent: a send still signing fails at `putSigned`, before any broadcast. Signed bytes or a hash
   * already journalled: `held`.
   */
  close(idempotencyKey: string): Promise<CloseResult>;
}

/** In-memory journal — tests and single-process local runners. Not multi-replica safe. */
export class MemoryBroadcastStore implements BroadcastStore {
  private readonly map = new Map<string, string>();
  private readonly signed = new Map<string, string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  async get(idempotencyKey: string): Promise<string | null> {
    const v = this.map.get(idempotencyKey);
    return isHash(v) ? v : null;
  }

  async close(idempotencyKey: string): Promise<CloseResult> {
    // Check + set with no await between — atomic on the JS event loop, like `claim`.
    const existing = this.map.get(idempotencyKey);
    if (!existing || (existing === BROADCAST_PENDING && !this.signed.has(idempotencyKey))) {
      this.map.set(idempotencyKey, BROADCAST_CLOSED);
      this.#release(idempotencyKey);
      return keyClosed(idempotencyKey);
    }
    return existing === BROADCAST_CLOSED ? keyClosed(idempotencyKey) : 'held';
  }

  async claim(idempotencyKey: string): Promise<ClaimResult> {
    // Check + set with no await between — atomic on the JS event loop.
    const existing = this.map.get(idempotencyKey);
    if (existing === BROADCAST_CLOSED) return { kind: 'closed' };
    if (existing && existing !== BROADCAST_PENDING) {
      return { kind: 'done', txHash: existing };
    }
    if (existing === BROADCAST_PENDING) {
      const raw = this.signed.get(idempotencyKey);
      if (raw) return { kind: 'resume', signedRaw: raw };
      await this.#waitUntilSettled(idempotencyKey);
      const settled = this.map.get(idempotencyKey);
      if (settled === BROADCAST_CLOSED) return { kind: 'closed' };
      if (settled && settled !== BROADCAST_PENDING) {
        return { kind: 'done', txHash: settled };
      }
      const resumed = this.signed.get(idempotencyKey);
      if (resumed) return { kind: 'resume', signedRaw: resumed };
      throw new Error(`broadcast claim for ${idempotencyKey} stalled while pending`);
    }
    this.map.set(idempotencyKey, BROADCAST_PENDING);
    return { kind: 'mine' };
  }

  async hasSigned(idempotencyKey: string): Promise<boolean> {
    return this.signed.has(idempotencyKey);
  }

  /** True once `close` took the key. */
  isClosed(idempotencyKey: string): boolean {
    return this.map.get(idempotencyKey) === BROADCAST_CLOSED;
  }

  async putSigned(idempotencyKey: string, signedRaw: string): Promise<void> {
    if (!signedRaw || signedRaw === BROADCAST_PENDING) {
      throw new Error('signedRaw must be a non-empty signed transaction');
    }
    const existing = this.map.get(idempotencyKey);
    if (!existing) {
      throw new Error(`broadcast putSigned for ${idempotencyKey}: no claim row (call claim first)`);
    }
    if (existing === BROADCAST_CLOSED) {
      throw new Error(`broadcast putSigned for ${idempotencyKey}: the key was closed by a not_sent answer`);
    }
    if (existing !== BROADCAST_PENDING) {
      // Already settled — signed bytes are irrelevant; keep first hash.
      return;
    }
    const prior = this.signed.get(idempotencyKey);
    if (prior && prior !== signedRaw) {
      throw new Error(`broadcast putSigned for ${idempotencyKey}: signed payload mismatch`);
    }
    this.signed.set(idempotencyKey, signedRaw);
    this.#release(idempotencyKey);
  }

  async put(idempotencyKey: string, txHash: string): Promise<string> {
    if (txHash === BROADCAST_PENDING) {
      throw new Error('txHash must not be the pending sentinel');
    }
    if (txHash === BROADCAST_CLOSED) {
      throw new Error('txHash must not be the closed sentinel');
    }
    const existing = this.map.get(idempotencyKey);
    if (existing === BROADCAST_CLOSED) {
      throw new Error(`broadcast put for ${idempotencyKey}: the key was closed by a not_sent answer`);
    }
    if (existing && existing !== BROADCAST_PENDING) return existing;
    this.map.set(idempotencyKey, txHash);
    this.#release(idempotencyKey);
    return txHash;
  }

  reset(): void {
    this.map.clear();
    this.signed.clear();
    for (const list of this.waiters.values()) {
      for (const wake of list) wake();
    }
    this.waiters.clear();
  }

  #waitUntilSettled(idempotencyKey: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.waiters.get(idempotencyKey) ?? [];
      list.push(resolve);
      this.waiters.set(idempotencyKey, list);
    });
  }

  #release(idempotencyKey: string): void {
    const list = this.waiters.get(idempotencyKey);
    if (!list) return;
    this.waiters.delete(idempotencyKey);
    for (const wake of list) wake();
  }
}

/**
 * Minimal postgres.js surface used by the durable journal (keeps tests mockable).
 * Call signature is intentionally loose so real `postgres.Sql` is assignable
 * without dragging the full generic library into the type graph.
 */
export type BroadcastSql = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...values: any[]): Promise<readonly any[]>;
};

const DEFAULT_PENDING_POLL_MS = 50;
const DEFAULT_PENDING_MAX_WAITS = 200; // ~10s at 50ms

/**
 * Postgres-backed journal for multi-replica / crash-safe outbound crypto sends.
 *
 * claim uses INSERT … ON CONFLICT DO NOTHING so exactly one replica gets `mine`.
 * Concurrent claimers poll until a signed raw appears (`resume`) or a hash lands
 * (`done`). Crash after putSigned resumes the identical signed payload.
 */
export class PostgresBroadcastStore implements BroadcastStore {
  constructor(
    private readonly sql: BroadcastSql,
    private readonly opts: { pollMs?: number; maxWaits?: number } = {},
  ) {}

  async get(idempotencyKey: string): Promise<string | null> {
    const rows = (await this.sql`
      SELECT tx_hash FROM pay.crypto_broadcasts WHERE idempotency_key = ${idempotencyKey}
    `) as ReadonlyArray<{ tx_hash: string }>;
    const v = rows[0]?.tx_hash;
    return isHash(v) ? v : null;
  }

  async close(idempotencyKey: string): Promise<CloseResult> {
    const inserted = (await this.sql`
      INSERT INTO pay.crypto_broadcasts (idempotency_key, tx_hash)
      VALUES (${idempotencyKey}, ${BROADCAST_CLOSED})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `) as ReadonlyArray<{ idempotency_key: string }>;
    if (inserted.length > 0) return keyClosed(idempotencyKey);
    // A claim with no signed bytes yet: nothing can have left, and its sender's `putSigned` (which needs the pending
    // sentinel) now refuses, so taking it is safe whether that sender is gone or only slow.
    const taken = await this.sql`
      UPDATE pay.crypto_broadcasts
      SET tx_hash = ${BROADCAST_CLOSED}, updated_at = now()
      WHERE idempotency_key = ${idempotencyKey}
        AND tx_hash = ${BROADCAST_PENDING}
        AND signed_raw IS NULL
      RETURNING idempotency_key
    `;
    if (taken.length > 0) return keyClosed(idempotencyKey);
    const rows = (await this.sql`
      SELECT tx_hash FROM pay.crypto_broadcasts WHERE idempotency_key = ${idempotencyKey}
    `) as ReadonlyArray<{ tx_hash: string }>;
    return rows[0]?.tx_hash === BROADCAST_CLOSED ? keyClosed(idempotencyKey) : 'held';
  }

  async claim(idempotencyKey: string): Promise<ClaimResult> {
    const inserted = (await this.sql`
      INSERT INTO pay.crypto_broadcasts (idempotency_key, tx_hash)
      VALUES (${idempotencyKey}, ${BROADCAST_PENDING})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `) as ReadonlyArray<{ idempotency_key: string }>;
    if (inserted.length > 0) return { kind: 'mine' };

    const pollMs = this.opts.pollMs ?? DEFAULT_PENDING_POLL_MS;
    const maxWaits = this.opts.maxWaits ?? DEFAULT_PENDING_MAX_WAITS;
    for (let i = 0; i < maxWaits; i++) {
      const rows = (await this.sql`
        SELECT tx_hash, signed_raw FROM pay.crypto_broadcasts WHERE idempotency_key = ${idempotencyKey}
      `) as ReadonlyArray<{ tx_hash: string; signed_raw: string | null }>;
      const row = rows[0];
      if (!row) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (row.tx_hash === BROADCAST_CLOSED) return { kind: 'closed' };
      if (row.tx_hash && row.tx_hash !== BROADCAST_PENDING) {
        return { kind: 'done', txHash: row.tx_hash };
      }
      if (row.signed_raw) {
        return { kind: 'resume', signedRaw: row.signed_raw };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`broadcast claim for ${idempotencyKey} stalled while pending`);
  }

  async hasSigned(idempotencyKey: string): Promise<boolean> {
    const rows = (await this.sql`
      SELECT signed_raw FROM pay.crypto_broadcasts WHERE idempotency_key = ${idempotencyKey}
    `) as ReadonlyArray<{ signed_raw: string | null }>;
    return Boolean(rows[0]?.signed_raw);
  }

  async putSigned(idempotencyKey: string, signedRaw: string): Promise<void> {
    if (!signedRaw || signedRaw === BROADCAST_PENDING) {
      throw new Error('signedRaw must be a non-empty signed transaction');
    }
    const updated = (await this.sql`
      UPDATE pay.crypto_broadcasts
      SET signed_raw = ${signedRaw}, updated_at = now()
      WHERE idempotency_key = ${idempotencyKey}
        AND tx_hash = ${BROADCAST_PENDING}
        AND (signed_raw IS NULL OR signed_raw = ${signedRaw})
      RETURNING idempotency_key
    `) as ReadonlyArray<{ idempotency_key: string }>;
    if (updated.length > 0) return;

    const existing = (await this.sql`
      SELECT tx_hash, signed_raw FROM pay.crypto_broadcasts WHERE idempotency_key = ${idempotencyKey}
    `) as ReadonlyArray<{ tx_hash: string; signed_raw: string | null }>;
    const row = existing[0];
    if (!row) {
      throw new Error(`broadcast putSigned for ${idempotencyKey}: no claim row (call claim first)`);
    }
    if (row.tx_hash === BROADCAST_CLOSED) {
      throw new Error(`broadcast putSigned for ${idempotencyKey}: the key was closed by a not_sent answer`);
    }
    if (row.tx_hash && row.tx_hash !== BROADCAST_PENDING) return;
    if (row.signed_raw && row.signed_raw !== signedRaw) {
      throw new Error(`broadcast putSigned for ${idempotencyKey}: signed payload mismatch`);
    }
    if (row.signed_raw === signedRaw) return;
    throw new Error(`broadcast putSigned for ${idempotencyKey}: could not persist signed raw`);
  }

  async put(idempotencyKey: string, txHash: string): Promise<string> {
    if (txHash === BROADCAST_PENDING || txHash === BROADCAST_CLOSED) {
      throw new Error('txHash must not be a sentinel');
    }
    // Only replace pending (or same hash). Never overwrite a different settled hash.
    const updated = (await this.sql`
      UPDATE pay.crypto_broadcasts
      SET tx_hash = ${txHash}, updated_at = now()
      WHERE idempotency_key = ${idempotencyKey}
        AND (tx_hash = ${BROADCAST_PENDING} OR tx_hash = ${txHash})
      RETURNING tx_hash
    `) as ReadonlyArray<{ tx_hash: string }>;
    if (updated[0]?.tx_hash) return updated[0].tx_hash;

    const existing = (await this.sql`
      SELECT tx_hash FROM pay.crypto_broadcasts WHERE idempotency_key = ${idempotencyKey}
    `) as ReadonlyArray<{ tx_hash: string }>;
    const v = existing[0]?.tx_hash;
    if (v === BROADCAST_CLOSED) {
      throw new Error(`broadcast put for ${idempotencyKey}: the key was closed by a not_sent answer`);
    }
    if (isHash(v)) return v;
    throw new Error(`broadcast put for ${idempotencyKey}: no claim row (call claim first)`);
  }
}
