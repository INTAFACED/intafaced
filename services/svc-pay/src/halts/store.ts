import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { PayHaltPendingClear, PayHaltPendingClearListInput } from '@intafaced/contracts';
import type {
  PayHaltEvent,
  PayHaltMerchantState,
  PayHaltOperatorStatus,
  PayHaltScope,
  PayHaltSetInput,
  PayHaltSetResult,
  PayHaltState,
  PayHaltStatus,
  PayHaltTarget,
} from './types.js';
import { PAY_HALT_SCOPES } from './types.js';
import { dualControlRefuse } from '../dual-control.js';
import type { PayHaltAutoTripConfig } from './config.js';

/**
 * THE HALT STORE (W5). Postgres is the only copy of a halt, so every svc-pay
 * replica sees the same switch the moment it commits. There is no in-process
 * cache: the guards read one indexed row per call. A read that fails is the
 * caller's problem to treat as HALTED (see guards.ts); this class never invents
 * "not halted" from an error.
 */

export class PayHaltError extends Error {
  constructor(
    readonly code: 'pay.halt_target_not_found' | 'pay.halt_store_unavailable',
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'PayHaltError';
  }
}

/** A proposed clear that nobody confirmed within this long is dead; a fresh proposal is needed. */
export const CLEAR_PROPOSAL_TTL_MS = 60 * 60 * 1000;

export const targetKey = (target: PayHaltTarget): string => (target.level === 'global' ? 'global' : target.merchantId.toLowerCase());
const targetOf = (key: string): PayHaltTarget => (key === 'global' ? { level: 'global' } : { level: 'merchant', merchantId: key });
const iso = (value: unknown): string | null => (value == null ? null : new Date(value as string | Date).toISOString());

interface HaltRow {
  scope: PayHaltScope;
  target: string;
  halted: boolean;
  reason: string | null;
  source: 'operator' | 'auto_trip';
  actor_user_id: string | null;
  version: string | number | bigint;
  changed_at: Date | string;
}

function stateOf(row: HaltRow): PayHaltState {
  return {
    scope: row.scope,
    target: targetOf(row.target),
    halted: row.halted,
    reason: row.reason,
    source: row.source,
    actorUserId: row.actor_user_id,
    version: String(row.version),
    changedAt: iso(row.changed_at),
  };
}

const neverHalted = (scope: PayHaltScope, target: PayHaltTarget): PayHaltState => ({
  scope,
  target,
  halted: false,
  reason: null,
  source: null,
  actorUserId: null,
  version: '0',
  changedAt: null,
});

/** What a merchant may see: on/off and since when. No reason, no actor, no source. */
export const merchantSafe = (state: PayHaltState): PayHaltMerchantState => ({
  scope: state.scope,
  target: state.target,
  halted: state.halted,
  changedAt: state.changedAt,
});

/** Stable streak key for one payout rail. Two rails do not share a count. */
export const payoutRailSourceKey = (railId: string): string => `rail:${railId}`;

/** The scope+target of a halt that is ON and covers this work. */
export interface BlockingHalt {
  readonly scope: PayHaltScope;
  readonly target: string;
}

/**
 * Is `scope` halted, globally or for `merchantId`? Reads through `conn` so a
 * guard running inside a money transaction asks on its own connection. THROWS if
 * the store cannot be read; the caller must treat that as halted.
 */
export async function findBlockingHalt(conn: Sql, scope: PayHaltScope, merchantId?: string): Promise<BlockingHalt | null> {
  return findBlockingHaltForTargets(conn, scope, [merchantId?.toLowerCase() ?? 'global']);
}

/**
 * First halted switch for `scope` among the global switch and `targets` (lower-cased merchant ids).
 * The one query behind `findBlockingHalt` and the user-money guard, so the two cannot drift.
 */
export async function findBlockingHaltForTargets(conn: Sql, scope: PayHaltScope, targets: readonly string[]): Promise<BlockingHalt | null> {
  const rows = await conn<Array<{ scope: PayHaltScope; target: string }>>`
    SELECT scope, target FROM pay.halts
     WHERE scope = ${scope} AND halted AND target IN ${conn(['global', ...targets])}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export class PayHaltStore {
  constructor(
    private readonly sql: Sql,
    private readonly autoTrip: PayHaltAutoTripConfig,
  ) {}

  autoTripPosture() {
    return this.autoTrip.failures === null
      ? { enabled: false, consecutiveFailures: null }
      : { enabled: true, consecutiveFailures: this.autoTrip.failures };
  }

  /** Merchant-safe effective status: per scope, the global switch and (when given) that merchant's switch. */
  async status(merchantId?: string): Promise<PayHaltStatus> {
    try {
      const merchant = merchantId?.toLowerCase();
      const rows = await this.sql<HaltRow[]>`
        SELECT * FROM pay.halts WHERE target = 'global' OR target = ${merchant ?? 'global'}
      `;
      const states: PayHaltState[] = [];
      for (const scope of PAY_HALT_SCOPES) {
        const targets: PayHaltTarget[] = [{ level: 'global' }];
        if (merchant) targets.push({ level: 'merchant', merchantId: merchant });
        for (const target of targets) {
          const row = rows.find((r) => r.scope === scope && r.target === targetKey(target));
          states.push(row ? stateOf(row) : neverHalted(scope, target));
        }
      }
      return { readable: true, states: states.map(merchantSafe) };
    } catch {
      // Unreadable = halted. The shape says so; every scope is reported halted.
      return {
        readable: false,
        states: PAY_HALT_SCOPES.map((scope) => ({ scope, target: { level: 'global' as const }, halted: true, changedAt: null })),
      };
    }
  }

  /**
   * Operator view of the switches that cover one merchant: the global switch and that merchant's switch,
   * per scope. Other merchants' rows are not included. A missing row is "never set" (`halted: false`,
   * version `0`), the same as `operatorStatus`. A failed read is `readable: false`, not "nothing is halted".
   */
  async operatorStatusForMerchant(merchantId: string): Promise<PayHaltOperatorStatus> {
    const autoTrip = this.autoTripPosture();
    const merchant = merchantId.toLowerCase();
    try {
      const rows = await this.sql<HaltRow[]>`
        SELECT * FROM pay.halts WHERE target = 'global' OR target = ${merchant} ORDER BY scope, target
      `;
      const states = rows.map(stateOf);
      for (const scope of PAY_HALT_SCOPES) {
        if (!states.some((s) => s.scope === scope && s.target.level === 'global')) states.push(neverHalted(scope, { level: 'global' }));
        if (!states.some((s) => s.scope === scope && s.target.level === 'merchant' && s.target.merchantId === merchant)) {
          states.push(neverHalted(scope, { level: 'merchant', merchantId: merchant }));
        }
      }
      return { readable: true, autoTrip, states };
    } catch {
      return { readable: false, autoTrip, states: [] };
    }
  }

  /** Operator view: every halt row that exists, plus the global switch of each scope even when never set. */
  async operatorStatus(): Promise<PayHaltOperatorStatus> {
    const autoTrip = this.autoTripPosture();
    try {
      const rows = await this.sql<HaltRow[]>`SELECT * FROM pay.halts ORDER BY scope, target`;
      const states = rows.map(stateOf);
      for (const scope of PAY_HALT_SCOPES) {
        if (!states.some((s) => s.scope === scope && s.target.level === 'global')) states.push(neverHalted(scope, { level: 'global' }));
      }
      return { readable: true, autoTrip, states };
    } catch {
      return { readable: false, autoTrip, states: [] };
    }
  }

  async history(input: { scope?: PayHaltScope; target?: PayHaltTarget; limit: number }): Promise<PayHaltEvent[]> {
    const scope = input.scope ?? null;
    const target = input.target ? targetKey(input.target) : null;
    const rows = await this.sql<Array<HaltRow & { confirmed_by_user_id: string | null; occurred_at: Date | string }>>`
      SELECT scope, target, halted, reason, source, actor_user_id, confirmed_by_user_id, version, occurred_at AS changed_at, occurred_at
        FROM pay.halt_events
       WHERE (${scope}::text IS NULL OR scope = ${scope}) AND (${target}::text IS NULL OR target = ${target})
       ORDER BY id DESC
       LIMIT ${input.limit}
    `;
    return rows.map((row) => ({ ...stateOf(row), confirmedByUserId: row.confirmed_by_user_id }));
  }

  /**
   * Clears a founder has proposed that a different founder has not confirmed, still inside the
   * confirm window, and whose expected_version still equals the current halt version. A proposal
   * left behind after the halt moved is omitted.
   *
   * Ordered by request id. That cursor can skip a row inserted behind it: request ids are random
   * UUIDs, so a new id that sorts before the cursor never appears on a later page.
   */
  async pendingClears(input: PayHaltPendingClearListInput): Promise<{ proposals: PayHaltPendingClear[]; nextCursor: string | null }> {
    const cursor = input.cursor ?? null;
    const oldest = new Date(Date.now() - CLEAR_PROPOSAL_TTL_MS);
    const rows = await this.sql<
      Array<{
        request_id: string;
        scope: PayHaltScope;
        target: string;
        expected_version: string | number | bigint;
        reason: string;
        requested_by_user_id: string;
        requested_at: Date | string;
      }>
    >`
      SELECT r.request_id, r.scope, r.target, r.expected_version, r.reason, r.requested_by_user_id, r.requested_at
        FROM pay.halt_clear_requests r
        JOIN pay.halts h
          ON h.scope = r.scope AND h.target = r.target AND h.halted AND h.version = r.expected_version
       WHERE r.status = 'pending'
         AND r.requested_at >= ${oldest}
         AND (${cursor}::uuid IS NULL OR r.request_id > ${cursor}::uuid)
       ORDER BY r.request_id ASC
       LIMIT ${input.limit + 1}
    `;
    const page = rows.slice(0, input.limit);
    return {
      proposals: page.map((row) => ({
        requestId: row.request_id,
        scope: row.scope,
        target: targetOf(row.target),
        expectedVersion: String(row.expected_version),
        reason: row.reason,
        requestedByUserId: row.requested_by_user_id,
        requestedAt: new Date(row.requested_at).toISOString(),
      })),
      nextCursor: rows.length > input.limit ? page[page.length - 1]!.request_id : null,
    };
  }

  /**
   * Operator set or clear.
   *   SET   one founder, immediate (the fast stop).
   *   CLEAR two distinct founders: the first call records a proposal and answers
   *         `pending_confirmation`; a DIFFERENT founder repeating the call (same
   *         requestId, same scope/target/expectedVersion) applies it.
   * `expectedVersion` is checked on every path that writes; a stale one is `conflict`.
   */
  async set(actorUserId: string, input: PayHaltSetInput): Promise<PayHaltSetResult> {
    const actor = actorUserId.toLowerCase();
    const key = targetKey(input.target);
    if (input.target.level === 'merchant') {
      const found = await this.sql`SELECT 1 FROM pay.merchants WHERE id = ${key}`;
      if (found.length === 0) throw new PayHaltError('pay.halt_target_not_found');
    }
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.halt:${input.scope}:${key}`}))`;
        const requestId = input.requestId.toLowerCase();
        const repeated = await tx<HaltRow[]>`
          SELECT scope, target, halted, reason, source, actor_user_id, version, occurred_at AS changed_at
            FROM pay.halt_events WHERE request_id = ${requestId}
        `;
        if (repeated[0]) {
          const same = repeated[0].scope === input.scope && repeated[0].target === key && repeated[0].halted === input.halted;
          return {
            requestId,
            outcome: same ? ('noop' as const) : ('conflict' as const),
            state: await this.current(tx, input.scope, input.target),
          };
        }
        const state = await this.current(tx, input.scope, input.target);
        const done = (outcome: PayHaltSetResult['outcome'], current: PayHaltState): PayHaltSetResult => ({
          requestId,
          outcome,
          state: current,
        });
        if (!input.halted) return this.clear(tx, actor, requestId, input, key, state, done);

        if (String(input.expectedVersion) !== state.version) return done('conflict', state);
        if (state.halted) return done('noop', state);
        const next = await this.write(tx, {
          scope: input.scope,
          key,
          halted: true,
          reason: input.reason,
          source: 'operator',
          actor,
          confirmedBy: null,
          requestId,
        });
        return done('changed', next);
      },
      { isolation: 'read committed' },
    );
  }

  private async clear(
    tx: Sql,
    actor: string,
    requestId: string,
    input: PayHaltSetInput,
    key: string,
    state: PayHaltState,
    done: (outcome: PayHaltSetResult['outcome'], current: PayHaltState) => PayHaltSetResult,
  ): Promise<PayHaltSetResult> {
    if (String(input.expectedVersion) !== state.version) return done('conflict', state);
    if (!state.halted) return done('noop', state);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.scope, key, input.expectedVersion]))
      .digest('hex');
    const proposals = await tx<
      Array<{
        scope: string;
        target: string;
        expected_version: string | number;
        requested_by_user_id: string;
        requested_at: Date;
        status: string;
      }>
    >`SELECT * FROM pay.halt_clear_requests WHERE request_id = ${requestId} FOR UPDATE`;
    const proposal = proposals[0];
    if (!proposal) {
      await tx`
        INSERT INTO pay.halt_clear_requests (request_id, scope, target, expected_version, reason, requested_by_user_id)
        VALUES (${requestId}, ${input.scope}, ${key}, ${String(input.expectedVersion)}, ${input.reason}, ${actor})
      `;
      return done('pending_confirmation', state);
    }
    const theirs = createHash('sha256')
      .update(JSON.stringify([proposal.scope, proposal.target, String(proposal.expected_version)]))
      .digest('hex');
    if (theirs !== fingerprint || proposal.status !== 'pending') return done('conflict', state);
    if (Date.now() - new Date(proposal.requested_at).getTime() > CLEAR_PROPOSAL_TTL_MS) return done('conflict', state);
    // Two distinct founders, or it does not happen. Same actor repeating = still waiting.
    if (dualControlRefuse(proposal.requested_by_user_id, actor)) return done('pending_confirmation', state);
    const next = await this.write(tx, {
      scope: input.scope,
      key,
      halted: false,
      reason: input.reason,
      source: 'operator',
      actor: proposal.requested_by_user_id.toLowerCase(),
      confirmedBy: actor,
      requestId,
    });
    await tx`UPDATE pay.halt_clear_requests SET status = 'applied' WHERE request_id = ${requestId}`;
    // A cleared halt starts counting failures from zero, or it would re-trip on the old streak.
    await tx`DELETE FROM pay.halt_failure_streaks WHERE scope = ${input.scope} AND target = ${key}`;
    return done('changed', next);
  }

  private async current(tx: Sql, scope: PayHaltScope, target: PayHaltTarget): Promise<PayHaltState> {
    const rows = await tx<HaltRow[]>`SELECT * FROM pay.halts WHERE scope = ${scope} AND target = ${targetKey(target)}`;
    return rows[0] ? stateOf(rows[0]) : neverHalted(scope, target);
  }

  /** The one writer of `pay.halts` + `pay.halt_events`. The caller holds the advisory lock for (scope, key). */
  private async write(
    tx: Sql,
    w: {
      scope: PayHaltScope;
      key: string;
      halted: boolean;
      reason: string;
      source: 'operator' | 'auto_trip';
      actor: string | null;
      confirmedBy: string | null;
      requestId: string | null;
    },
  ): Promise<PayHaltState> {
    const rows = await tx<HaltRow[]>`
      INSERT INTO pay.halts (scope, target, halted, reason, source, actor_user_id, version)
      VALUES (${w.scope}, ${w.key}, ${w.halted}, ${w.reason}, ${w.source}, ${w.actor}, 1)
      ON CONFLICT (scope, target) DO UPDATE
         SET halted = EXCLUDED.halted, reason = EXCLUDED.reason, source = EXCLUDED.source,
             actor_user_id = EXCLUDED.actor_user_id, version = pay.halts.version + 1, changed_at = now()
      RETURNING *
    `;
    const row = rows[0]!;
    await tx`
      INSERT INTO pay.halt_events (scope, target, halted, reason, source, actor_user_id, confirmed_by_user_id, request_id, version)
      VALUES (${w.scope}, ${w.key}, ${w.halted}, ${w.reason}, ${w.source}, ${w.actor}, ${w.confirmedBy}, ${w.requestId}, ${String(row.version)})
    `;
    return stateOf(row);
  }

  /**
   * AUTO-TRIP, failure side. Called after a confirmed rail or venue refusal,
   * with a merchant target and a stable `sourceKey` such as `rail:crypto-native`
   * or `venue:binance`. The count is per merchant and per source key. Reaching
   * the configured count halts that merchant's scope (`source: auto_trip`).
   *
   * Unconfigured count: records nothing and trips nothing. A global target is
   * the same: one merchant's rail cannot arm a platform-wide halt.
   *
   * Failures before the configured count's effective time do not add. That time
   * is the row in `pay.halt_autotrip_window`, written when a count is first
   * observed and kept when a later process has the same count. It is not the
   * start of this process.
   *
   * `conn`, when passed, must be idle (not already in a transaction). The write
   * then uses that connection so a caller holding the pool's only connection
   * does not wait on itself. Omit it to take a connection from the pool.
   */
  async recordFailure(
    scope: PayHaltScope,
    target: PayHaltTarget,
    sourceKey: string,
    conn?: Sql,
  ): Promise<{ tripped: boolean; consecutiveFailures: number }> {
    const limit = this.autoTrip.failures;
    if (limit === null || target.level !== 'merchant') return { tripped: false, consecutiveFailures: 0 };
    if (!conn) {
      return transaction(this.sql, (tx) => this.applyFailure(tx, scope, target, sourceKey, limit), { isolation: 'read committed' });
    }
    await conn`BEGIN ISOLATION LEVEL READ COMMITTED`;
    try {
      const result = await this.applyFailure(conn, scope, target, sourceKey, limit);
      await conn`COMMIT`;
      return result;
    } catch (error) {
      await conn`ROLLBACK`;
      throw error;
    }
  }

  /** A success ends the streak for that merchant and source. Off, or a global target, writes nothing. */
  async recordSuccess(scope: PayHaltScope, target: PayHaltTarget, sourceKey: string, conn?: Sql): Promise<void> {
    if (this.autoTrip.failures === null || target.level !== 'merchant') return;
    const db = conn ?? this.sql;
    await db`
      UPDATE pay.halt_failure_streaks SET consecutive_failures = 0, updated_at = now()
       WHERE scope = ${scope} AND target = ${targetKey(target)} AND source_key = ${sourceKey} AND consecutive_failures <> 0
    `;
  }

  /**
   * The configured count's effective time. Same count keeps the stored time.
   * A different count starts a new window and zeroes streaks, so a same-millisecond
   * change cannot carry the previous run.
   */
  private async armWindow(tx: Sql, limit: number): Promise<Date> {
    const rows = await tx<Array<{ failures: string | number; effective_at: Date }>>`
      INSERT INTO pay.halt_autotrip_window (singleton, failures, effective_at)
      VALUES ('autotrip', ${limit}, now())
      ON CONFLICT (singleton) DO UPDATE
        SET singleton = pay.halt_autotrip_window.singleton
      RETURNING failures, effective_at
    `;
    const row = rows[0]!;
    if (Number(row.failures) === limit) return new Date(row.effective_at);
    const updated = await tx<Array<{ effective_at: Date }>>`
      UPDATE pay.halt_autotrip_window
         SET failures = ${limit}, effective_at = now()
       WHERE singleton = 'autotrip'
      RETURNING effective_at
    `;
    await tx`
      UPDATE pay.halt_failure_streaks
         SET consecutive_failures = 0, last_failure_at = NULL, updated_at = now()
    `;
    return new Date(updated[0]!.effective_at);
  }

  private async applyFailure(
    tx: Sql,
    scope: PayHaltScope,
    target: PayHaltTarget,
    sourceKey: string,
    limit: number,
  ): Promise<{ tripped: boolean; consecutiveFailures: number }> {
    const key = targetKey(target);
    // Compare against the stored timestamp in SQL. A JS Date would drop
    // microseconds and could count a failure that is still before the window.
    await this.armWindow(tx, limit);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.halt:${scope}:${key}`}))`;
    const rows = await tx<Array<{ consecutive_failures: string | number }>>`
      INSERT INTO pay.halt_failure_streaks (scope, target, source_key, consecutive_failures, last_failure_at)
      VALUES (${scope}, ${key}, ${sourceKey}, 1, now())
      ON CONFLICT (scope, target, source_key) DO UPDATE
         SET consecutive_failures = CASE
               WHEN pay.halt_failure_streaks.last_failure_at IS NULL
                 OR pay.halt_failure_streaks.last_failure_at < (
                   SELECT effective_at FROM pay.halt_autotrip_window WHERE singleton = 'autotrip'
                 )
               THEN 1
               ELSE pay.halt_failure_streaks.consecutive_failures + 1
             END,
             last_failure_at = now(),
             updated_at = now()
      RETURNING consecutive_failures
    `;
    const count = Number(rows[0]!.consecutive_failures);
    if (count < limit) return { tripped: false, consecutiveFailures: count };
    return {
      tripped: await this.tripLocked(tx, scope, key, `auto_trip: ${count} consecutive failures of ${sourceKey}`),
      consecutiveFailures: count,
    };
  }

  private async tripLocked(tx: Sql, scope: PayHaltScope, key: string, reason: string): Promise<boolean> {
    const rows = await tx<HaltRow[]>`SELECT * FROM pay.halts WHERE scope = ${scope} AND target = ${key}`;
    if (rows[0]?.halted) return false;
    await this.write(tx, { scope, key, halted: true, reason, source: 'auto_trip', actor: null, confirmedBy: null, requestId: null });
    return true;
  }
}
