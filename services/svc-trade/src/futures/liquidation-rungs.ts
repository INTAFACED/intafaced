/**
 * LIQUIDATION RUNGS — a rung is a state machine on one position row.
 *
 * A rung is one tranche of a liquidation: a partial reduction, or the closing
 * rung. It is written down BEFORE its first ledger post and walks one way:
 *
 *     planned ──post every recipe──▶ posted ──row moves, same tx──▶ applied
 *        └──── a row that cannot be reconciled with a booked loss ──▶ abandoned ──operator──▶ resolved
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
 * ONCE THE LOSS IS BOOKED, THE ROW MOVES BY A DELTA, NOT BY A SNAPSHOT. `begin`
 * compares the row with what the decision read BEFORE any money moves — a stale
 * snapshot is refused there. After the posts, ordinary writers (funding takes
 * margin, the trader adds or withdraws margin, closes part of the position) can
 * legitimately move the row, and refusing the rung because they did would leave a
 * booked loss the row never reflects and invite a re-plan that books the same
 * tranche again. So a partial rung applies `size - sizeClosed` and
 * `margin_current - marginTaken` (floored at zero) to whatever the row is now. Only
 * what cannot be reconciled is abandoned — a row that is closed, or no larger than
 * the tranche, or a closing rung whose size changed — and an abandoned rung PARKS
 * the position: no new rung is planned until an operator has reconciled it and
 * marked it `resolved`.
 *
 * MARGIN DRIFT DOES NOT BLOCK A CLOSE. A closing rung's loss (and its stored
 * residual release) is booked; leaving the row open and tradable because the margin
 * moved meanwhile (the trader added some, funding took some) would leave a
 * liquidated-in-the-ledger position live. So the row closes when its SIZE is what
 * the rung was planned against, whatever the margin, and the difference is recorded
 * (`marginDrift`) and raised as `trade.liquidation_margin_drift` for an operator.
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
export type RungState = 'planned' | 'posted' | 'applied' | 'abandoned' | 'resolved';

/** What the rung committed to, fixed before its first post. */
export interface RungPlan {
  /** Exactly what posts, idempotency keys included. */
  recipes: PostRequest[];
  /** Leaves the position (a partial rung) — the whole row on a closing rung. */
  sizeClosed: Amount;
  /** What `margin_current` becomes. Zero on a closing rung. Informational: a partial rung applies `marginTaken` as a delta. */
  marginRemaining: Amount;
  /** The margin this rung's loss took out of the position's pot (the loss recipe's `fromMargin`). */
  marginTaken: Amount;
  /**
   * How much LESS than planned the margin release actually returns (>= 0). Set when the
   * pot no longer held the planned amount at post time (funding or a margin withdrawal
   * took some first) and the release was amended to what the pot holds. The amendment
   * is persisted before it posts, so a replay posts the same amended body.
   */
  releaseShort: Amount;
  /**
   * How much LESS of the loss was booked against the position's pot than planned (>= 0):
   * the pot held less than the loss's pot leg when it posted. On a closing rung the
   * difference moved to the insurance leg instead (`fromInsurance` grew), so nothing is
   * under-booked and this stays 0; on a partial rung it is the under-booked loss.
   */
  lossShort: Amount;
  reason: string;
  /** The insurance leg of the loss: re-checked before a replay that has not booked it. */
  fromInsurance: Amount;
  marginAsset: string;
  /** The mark this rung was planned against, when the writer recorded it. */
  markPrice?: Amount;
  /** A liquidation fee the writer recorded. Absent means no fee was recorded. */
  fee?: Amount;
}

export interface RungRecord {
  rungId: string;
  positionId: string;
  /** The lifecycle id the closing announcement is keyed on. */
  liquidationId: string;
  kind: RungKind;
  /** The row this rung was planned against: it applies only to a row still exactly like this. */
  fromSize: Amount;
  fromMargin: Amount;
  plan: RungPlan;
  state: RungState;
  /** Bumped by every `amendPlan`; an amendment applies only to the version its author read. */
  planVersion: number;
  /**
   * Set when the rung applied. Closing rung: the margin the row held at close minus
   * the margin the stored release was computed from (positive: margin the trader added
   * is stranded in the collateral pot; negative: funding took margin). Partial rung:
   * the NEGATIVE shortfall when the zero floor on `margin_current` bit (the row held
   * less than the loss took); 0 otherwise.
   */
  marginDrift: Amount;
}

export interface BeginRungInput {
  rungId: string;
  positionId: string;
  liquidationId: string;
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

/** A rung that applied, but whose margin did not reconcile. Raised at error level by `reportLiquidationTick`. */
export interface RungAlert {
  code: 'trade.liquidation_margin_drift' | 'trade.liquidation_margin_clipped';
  /** Signed; see `RungRecord.marginDrift`. */
  amount: Amount;
}

export type ApplyRungResult =
  /** This call moved the row and set the rung 'applied' (one transaction). `alert` is set when the margin did not reconcile. */
  | { status: 'applied'; alert?: RungAlert }
  /** Another call already did. */
  | { status: 'already_applied' }
  /**
   * The row cannot be reconciled with the booked loss (closed or gone, no larger
   * than the tranche, or a closing rung whose size changed). The rung is now
   * 'abandoned' and the position is parked — an operator's problem, never a success.
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
   * COMPARE-AND-SET the stored plan of a rung that is still 'planned'. Used to persist an
   * amended recipe BEFORE it posts, so any replay posts the amended body. It applies only
   * if the stored plan is still the version the caller read (`expectedVersion`); two
   * workers amending at once cannot both win, so only one amended body is ever posted.
   * Resolves the new version, or null — writing nothing — when the rung is no longer
   * 'planned' or somebody else amended first (the caller re-reads and posts what is stored).
   */
  amendPlan(rungId: string, plan: RungPlan, expectedVersion: number): Promise<number | null>;
  /**
   * Under a row lock, in ONE transaction: apply the rung to the row AND set it
   * 'applied'. Partial: size and margin move by the stored DELTA on whatever the
   * row is now (open, and larger than the tranche). Closing: the row closes if it is
   * still the size the rung was planned against, whatever its margin. Anything else
   * abandons the rung.
   */
  apply(positionId: string, rungId: string): Promise<ApplyRungResult>;
  /** The position's LATEST rung is 'abandoned': no new rung may be planned until an operator marks it 'resolved'. */
  isParked(positionId: string): Promise<boolean>;
  /** Applied closing rungs whose bus announcement has not been recorded as published. Oldest first. */
  listUnannounced(limit: number): Promise<RungRecord[]>;
  /** The announcement went out (the publish key makes a repeat harmless). */
  markAnnounced(rungId: string): Promise<void>;
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
  marginTaken: string;
  releaseShort: string;
  lossShort: string;
  reason: string;
  fromInsurance: string;
  marginAsset: string;
  /** Scaled integer string. Omitted when the writer did not record a mark. */
  markPrice?: string;
  /** Scaled integer string. Omitted when the writer did not record a fee. */
  fee?: string;
}

export function encodeRungPlan(plan: RungPlan): EncodedRungPlan {
  // Named locals: the recipe live-path scanner reads `recipes.<name>` as a call on the ledger recipe book.
  const legs = plan.recipes;
  return {
    recipes: legs.map((r) => ({
      ...r,
      entries: r.entries.map((e) => ({ account: e.account, direction: e.direction, amount: e.amount.toString() })),
    })),
    sizeClosed: plan.sizeClosed.toString(),
    marginRemaining: plan.marginRemaining.toString(),
    marginTaken: plan.marginTaken.toString(),
    releaseShort: plan.releaseShort.toString(),
    lossShort: plan.lossShort.toString(),
    reason: plan.reason,
    fromInsurance: plan.fromInsurance.toString(),
    marginAsset: plan.marginAsset,
    ...(plan.markPrice != null ? { markPrice: plan.markPrice.toString() } : {}),
    ...(plan.fee != null ? { fee: plan.fee.toString() } : {}),
  };
}

export function decodeRungPlan(encoded: EncodedRungPlan): RungPlan {
  const legs = encoded.recipes;
  return {
    recipes: legs.map((r) => ({
      ...r,
      entries: r.entries.map((e) => ({ account: e.account, direction: e.direction, amount: BigInt(e.amount) })),
    })),
    sizeClosed: BigInt(encoded.sizeClosed),
    marginRemaining: BigInt(encoded.marginRemaining),
    marginTaken: BigInt(encoded.marginTaken),
    releaseShort: BigInt(encoded.releaseShort ?? '0'),
    lossShort: BigInt(encoded.lossShort ?? '0'),
    reason: encoded.reason,
    fromInsurance: BigInt(encoded.fromInsurance),
    marginAsset: encoded.marginAsset,
    ...(encoded.markPrice != null ? { markPrice: BigInt(encoded.markPrice) } : {}),
    ...(encoded.fee != null ? { fee: BigInt(encoded.fee) } : {}),
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
  /** Called only for a row that is open and larger than `sizeClosed`; `newMargin` is already `max(margin - marginTaken, 0)`. */
  reduce(positionId: string, sizeClosed: Amount, newMargin: Amount): void;
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
  type Entry = { rec: Omit<RungRecord, 'plan'>; plan: EncodedRungPlan; announced: boolean };
  const rungs = new Map<string, Entry>();
  const view = (e: Entry): RungRecord => ({ ...e.rec, plan: decodeRungPlan(e.plan) });
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
      const entry: Entry = {
        rec: {
          rungId: input.rungId,
          positionId: input.positionId,
          liquidationId: input.liquidationId,
          kind: input.kind,
          fromSize: input.fromSize,
          fromMargin: input.fromMargin,
          state: 'planned',
          planVersion: 0,
          marginDrift: 0n,
        },
        plan: encodeRungPlan(input.plan),
        announced: false,
      };
      rungs.set(input.rungId, entry);
      return { status: 'created', rung: view(entry) };
    },
    async markPosted(rungId) {
      const e = rungs.get(rungId);
      if (e && e.rec.state === 'planned') e.rec.state = 'posted';
    },
    async amendPlan(rungId, plan, expectedVersion) {
      const e = rungs.get(rungId);
      if (!e || e.rec.state !== 'planned' || e.rec.planVersion !== expectedVersion) return null;
      e.plan = encodeRungPlan(plan);
      e.rec.planVersion += 1;
      return e.rec.planVersion;
    },
    async apply(positionId, rungId) {
      const e = rungs.get(rungId);
      if (!e || e.rec.positionId !== positionId) return { status: 'not_live' };
      if (e.rec.state === 'applied') return { status: 'already_applied' };
      if (e.rec.state === 'abandoned' || e.rec.state === 'resolved') return { status: 'not_live' };
      const abandon = (reason: 'row_changed' | 'row_missing' | 'reduction_no_op'): ApplyRungResult => {
        e.rec.state = 'abandoned';
        return { status: 'abandoned', reason };
      };
      const row = rows.read(positionId);
      if (!row) return abandon('row_missing');
      if (row.status !== 'open') return abandon('row_changed');
      const plan = decodeRungPlan(e.plan);
      if (e.rec.kind === 'partial') {
        if (plan.sizeClosed <= 0n || row.size <= plan.sizeClosed) return abandon('reduction_no_op');
        const margin = row.margin - plan.marginTaken;
        rows.reduce(positionId, plan.sizeClosed, margin < 0n ? 0n : margin);
        if (margin < 0n) {
          e.rec.marginDrift = margin; // the floor bit: the row held less than the loss took
          e.rec.state = 'applied';
          return { status: 'applied', alert: { code: 'trade.liquidation_margin_clipped', amount: margin } };
        }
      } else {
        // The loss and the stored release are booked, so the row closes if it is still
        // the size they were computed for — whatever the margin did meanwhile.
        if (row.size !== e.rec.fromSize) return abandon('row_changed');
        rows.close(positionId);
        const drift = row.margin - e.rec.fromMargin;
        if (drift !== 0n) {
          e.rec.marginDrift = drift;
          e.rec.state = 'applied';
          return { status: 'applied', alert: { code: 'trade.liquidation_margin_drift', amount: drift } };
        }
      }
      e.rec.state = 'applied';
      return { status: 'applied' };
    },
    async isParked(positionId) {
      const mine = [...rungs.values()].filter((e) => e.rec.positionId === positionId);
      return mine.length > 0 && mine[mine.length - 1]!.rec.state === 'abandoned';
    },
    async listUnannounced(limit) {
      return [...rungs.values()]
        .filter((e) => e.rec.kind === 'closing' && e.rec.state === 'applied' && !e.announced)
        .slice(0, limit)
        .map(view);
    },
    async markAnnounced(rungId) {
      const e = rungs.get(rungId);
      if (e) e.announced = true;
    },
  };
}
