import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
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
  const merchant = merchantId?.toLowerCase() ?? 'global';
  const rows = await conn<Array<{ scope: PayHaltScope; target: string }>>`
    SELECT scope, target FROM pay.halts
     WHERE scope = ${scope} AND halted AND target IN ('global', ${merchant})
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
   * AUTO-TRIP, failure side. Called by every path that talks to a rail or venue
   * for `scope`/`target` after a failed attempt, with a stable `sourceKey` such
   * as `venue:binance` or `rail:crypto-native`. Counts consecutive failures in
   * Postgres (so replicas share the count) and, on reaching the configured count,
   * sets the halt itself (`source: auto_trip`). With no count configured it
   * records nothing and trips nothing: auto-trip is OFF, and status says so.
   */
  async recordFailure(
    scope: PayHaltScope,
    target: PayHaltTarget,
    sourceKey: string,
  ): Promise<{ tripped: boolean; consecutiveFailures: number }> {
    const limit = this.autoTrip.failures;
    if (limit === null) return { tripped: false, consecutiveFailures: 0 };
    const key = targetKey(target);
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.halt:${scope}:${key}`}))`;
        const rows = await tx<Array<{ consecutive_failures: string | number }>>`
          INSERT INTO pay.halt_failure_streaks (scope, target, source_key, consecutive_failures, last_failure_at)
          VALUES (${scope}, ${key}, ${sourceKey}, 1, now())
          ON CONFLICT (scope, target, source_key) DO UPDATE
             SET consecutive_failures = pay.halt_failure_streaks.consecutive_failures + 1, last_failure_at = now(), updated_at = now()
          RETURNING consecutive_failures
        `;
        const count = Number(rows[0]!.consecutive_failures);
        if (count < limit) return { tripped: false, consecutiveFailures: count };
        return {
          tripped: await this.tripLocked(tx, scope, key, `auto_trip: ${count} consecutive failures of ${sourceKey}`),
          consecutiveFailures: count,
        };
      },
      { isolation: 'read committed' },
    );
  }

  /** A success ends the streak for that source. */
  async recordSuccess(scope: PayHaltScope, target: PayHaltTarget, sourceKey: string): Promise<void> {
    await this.sql`
      UPDATE pay.halt_failure_streaks SET consecutive_failures = 0, updated_at = now()
       WHERE scope = ${scope} AND target = ${targetKey(target)} AND source_key = ${sourceKey} AND consecutive_failures <> 0
    `;
  }

  /**
   * Trip from a streak derived elsewhere (the payout guard counts rail refusals
   * from the payout book). Runs on the pool, never on the caller's money
   * transaction, so the halt survives that transaction's rollback.
   */
  async trip(scope: PayHaltScope, target: PayHaltTarget, reason: string): Promise<boolean> {
    const key = targetKey(target);
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.halt:${scope}:${key}`}))`;
        return this.tripLocked(tx, scope, key, reason);
      },
      { isolation: 'read committed' },
    );
  }

  private async tripLocked(tx: Sql, scope: PayHaltScope, key: string, reason: string): Promise<boolean> {
    const rows = await tx<HaltRow[]>`SELECT * FROM pay.halts WHERE scope = ${scope} AND target = ${key}`;
    if (rows[0]?.halted) return false;
    await this.write(tx, { scope, key, halted: true, reason, source: 'auto_trip', actor: null, confirmedBy: null, requestId: null });
    return true;
  }

  /** When the (scope, target) switch last changed: the line before which old failures no longer count. */
  async lastChangeAt(conn: Sql, scope: PayHaltScope, target: PayHaltTarget): Promise<Date | null> {
    const rows = await conn<Array<{ changed_at: Date }>>`
      SELECT changed_at FROM pay.halts WHERE scope = ${scope} AND target = ${targetKey(target)}
    `;
    return rows[0] ? new Date(rows[0].changed_at) : null;
  }
}
