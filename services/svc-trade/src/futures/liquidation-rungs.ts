/**
 * LIQUIDATION RUNGS — a rung is a state machine on one position row.
 *
 * A rung is one tranche of a liquidation: a partial reduction, or the closing
 * rung. It is written down BEFORE its first ledger post and walks one way:
 *
 *     planned ──post every recipe──▶ posted ──row moves, same tx──▶ applied
 *        └───────────── row changed under it ───────────────────▶ abandoned
 *
 * WHY THE RUNG IS STORED, NOT RE-DERIVED. The ledger dedupes on a recipe's
 * idempotency key, and the key does not carry the amounts (soon the ledger will
 * refuse a reused key with a different body). Amounts come from the live mark. A
 * rung that posted and crashed before the row moved, re-planned on the next tick,
 * would present the same key with different money. So the recipes are persisted
 * first and a replay posts those exact bodies.
 *
 * WHY THE RUNG ID IS IN EVERY KEY. A position row can regrow to an earlier size
 * (the trader adds size back) and meet the same mark. Keys derived from
 * (size, mark) then collide with an old rung's booked key: the ledger returns the
 * OLD transaction, no new loss is booked and the row is reduced anyway. A rung id
 * minted per rung removes the collision.
 *
 * WHY EVERY ROW-STATE CHECK IS UNDER A ROW LOCK. Deciding on a snapshot read
 * earlier by `listOpen` and then writing is how a stale replica books a second
 * loss, and how a reducer that "matched no rows" got reported as success. `begin`
 * and `apply` below each lock the position row, compare it with what the rung was
 * planned against, and only then change anything — the rung's state moves in the
 * same transaction as the row.
 *
 * ONE LIVE RUNG PER POSITION (states planned, posted). Two replicas that plan the
 * same position converge: the loser of `begin` is handed the winner's rung and
 * replays it, so both post identical bodies.
 */
import { type Amount, type EntryInput, type PostRequest } from '@intafaced/ledger-client';

export type RungKind = 'partial' | 'closing';
export type RungState = 'planned' | 'posted' | 'applied' | 'abandoned';

/** What the rung committed to, fixed before its first post. */
export interface RungPlan {
  /** Exactly what posts, idempotency keys included. */
  recipes: PostRequest[];
  /** Leaves the position (a partial rung) — the whole row on a closing rung. */
  sizeClosed: Amount;
  /** What `margin_current` becomes. Zero on a closing rung. */
  marginRemaining: Amount;
  reason: string;
  /** The insurance leg of the loss: re-checked before a replay that has not booked it. */
  fromInsurance: Amount;
  marginAsset: string;
}

export interface RungRecord {
  rungId: string;
  positionId: string;
  kind: RungKind;
  /** The row this rung was planned against: it applies only to a row still exactly like this. */
  fromSize: Amount;
  fromMargin: Amount;
  plan: RungPlan;
  state: RungState;
}

export interface BeginRungInput {
  rungId: string;
  positionId: string;
  kind: RungKind;
  fromSize: Amount;
  fromMargin: Amount;
  plan: RungPlan;
}

export type BeginRungResult =
  /** This call wrote the rung. */
  | { status: 'created'; rung: RungRecord }
  /** Another worker's live rung already exists for the position; replay THAT one. */
  | { status: 'live'; rung: RungRecord }
  /** The row is no longer what the decision read (moved, closed, or gone). Nothing was written. */
  | { status: 'changed' };

export type ApplyRungResult =
  /** This call moved the row and set the rung 'applied' (one transaction). */
  | { status: 'applied' }
  /** Another call already did. */
  | { status: 'already_applied' }
  /**
   * The row no longer matches the rung (or the reduction matched no row). The
   * rung is now 'abandoned'. If the loss was booked, it is booked against a row
   * that did not move by it — an operator's problem, never a success.
   */
  | { status: 'abandoned'; reason: 'row_changed' | 'row_missing' | 'reduction_no_op' }
  /** The rung was abandoned earlier (or never existed): nothing to apply. */
  | { status: 'not_live' };

export interface LiquidationRungStore {
  /** The position's live (planned or posted) rung, or null. */
  findLive(positionId: string): Promise<RungRecord | null>;
  /**
   * Under a row lock: if the position has a live rung, hand it back (`live`);
   * else if the row still equals the snapshot (open, `fromSize`, `fromMargin`),
   * insert the rung as 'planned' (`created`); else `changed`.
   */
  begin(input: BeginRungInput): Promise<BeginRungResult>;
  /** Every recipe of the rung is booked. Idempotent. */
  markPosted(rungId: string): Promise<void>;
  /**
   * Under a row lock, in ONE transaction: if the row still matches the rung,
   * apply its reduction (partial) or close it (closing) AND set the rung
   * 'applied'. A row that no longer matches abandons the rung instead.
   */
  apply(positionId: string, rungId: string): Promise<ApplyRungResult>;
}

/** A mint of rung ids. Injected so tests can pin them; production uses `crypto.randomUUID`. */
export type RungIdFactory = () => string;

// ── jsonb codec ──────────────────────────────────────────────────────────────

/** {@link RungPlan} as it sits in jsonb: every amount a decimal-integer string, because JSON cannot hold a bigint. */
export interface EncodedRungPlan {
  recipes: (Omit<PostRequest, 'entries'> & {
    entries: { account: EntryInput['account']; direction: EntryInput['direction']; amount: string }[];
  })[];
  sizeClosed: string;
  marginRemaining: string;
  reason: string;
  fromInsurance: string;
  marginAsset: string;
}

export function encodeRungPlan(plan: RungPlan): EncodedRungPlan {
  return {
    recipes: plan.recipes.map((r) => ({
      ...r,
      entries: r.entries.map((e) => ({ account: e.account, direction: e.direction, amount: e.amount.toString() })),
    })),
    sizeClosed: plan.sizeClosed.toString(),
    marginRemaining: plan.marginRemaining.toString(),
    reason: plan.reason,
    fromInsurance: plan.fromInsurance.toString(),
    marginAsset: plan.marginAsset,
  };
}

export function decodeRungPlan(encoded: EncodedRungPlan): RungPlan {
  return {
    recipes: encoded.recipes.map((r) => ({
      ...r,
      entries: r.entries.map((e) => ({ account: e.account, direction: e.direction, amount: BigInt(e.amount) })),
    })),
    sizeClosed: BigInt(encoded.sizeClosed),
    marginRemaining: BigInt(encoded.marginRemaining),
    reason: encoded.reason,
    fromInsurance: BigInt(encoded.fromInsurance),
    marginAsset: encoded.marginAsset,
  };
}

// ── memory store ─────────────────────────────────────────────────────────────

/**
 * The position rows a memory rung store locks. In production these are
 * `trade.positions` under `SELECT … FOR UPDATE`; in a unit test they are whatever
 * the test treats as "the row".
 */
export interface RungRowBook {
  read(positionId: string): { status: 'open' | 'closed' | 'liquidated' | 'closing'; size: Amount; margin: Amount } | null;
  /** Called only for a row that is open and larger than `sizeClosed`. */
  reduce(positionId: string, sizeClosed: Amount, marginRemaining: Amount): void;
  close(positionId: string): void;
}

/**
 * The SQL store's semantics, in memory.
 *
 * `begin` and `apply` have no `await` between their reads and writes, so on one
 * event loop each is atomic — the same guarantee `FOR UPDATE` gives the SQL
 * store. A test that interleaves two ticks therefore meets the same outcomes
 * (one winner, one `live`/`changed`/`already_applied`) that Postgres produces.
 *
 * Plans are held ENCODED, as the SQL store holds them, so a test through here
 * runs the same round trip production does rather than sharing object identity.
 */
export function memoryLiquidationRungStore(rows: RungRowBook): LiquidationRungStore & { all(): RungRecord[] } {
  const rungs = new Map<string, { rec: Omit<RungRecord, 'plan'>; plan: EncodedRungPlan }>();
  const view = (e: { rec: Omit<RungRecord, 'plan'>; plan: EncodedRungPlan }): RungRecord => ({ ...e.rec, plan: decodeRungPlan(e.plan) });
  const live = (positionId: string) =>
    [...rungs.values()].find((e) => e.rec.positionId === positionId && (e.rec.state === 'planned' || e.rec.state === 'posted'));

  return {
    all: () => [...rungs.values()].map(view),
    async findLive(positionId) {
      const e = live(positionId);
      return e ? view(e) : null;
    },
    async begin(input) {
      const existing = live(input.positionId);
      if (existing) return { status: 'live', rung: view(existing) };
      const row = rows.read(input.positionId);
      if (!row || row.status !== 'open' || row.size !== input.fromSize || row.margin !== input.fromMargin) return { status: 'changed' };
      const entry = {
        rec: {
          rungId: input.rungId,
          positionId: input.positionId,
          kind: input.kind,
          fromSize: input.fromSize,
          fromMargin: input.fromMargin,
          state: 'planned' as RungState,
        },
        plan: encodeRungPlan(input.plan),
      };
      rungs.set(input.rungId, entry);
      return { status: 'created', rung: view(entry) };
    },
    async markPosted(rungId) {
      const e = rungs.get(rungId);
      if (e && e.rec.state === 'planned') e.rec.state = 'posted';
    },
    async apply(positionId, rungId) {
      const e = rungs.get(rungId);
      if (!e || e.rec.positionId !== positionId) return { status: 'not_live' };
      if (e.rec.state === 'applied') return { status: 'already_applied' };
      if (e.rec.state === 'abandoned') return { status: 'not_live' };
      const row = rows.read(positionId);
      if (!row) {
        e.rec.state = 'abandoned';
        return { status: 'abandoned', reason: 'row_missing' };
      }
      if (row.status !== 'open' || row.size !== e.rec.fromSize || row.margin !== e.rec.fromMargin) {
        e.rec.state = 'abandoned';
        return { status: 'abandoned', reason: 'row_changed' };
      }
      const plan = decodeRungPlan(e.plan);
      if (e.rec.kind === 'partial') {
        if (plan.sizeClosed <= 0n || row.size <= plan.sizeClosed) {
          e.rec.state = 'abandoned';
          return { status: 'abandoned', reason: 'reduction_no_op' };
        }
        rows.reduce(positionId, plan.sizeClosed, plan.marginRemaining < 0n ? 0n : plan.marginRemaining);
      } else {
        rows.close(positionId);
      }
      e.rec.state = 'applied';
      return { status: 'applied' };
    },
  };
}
