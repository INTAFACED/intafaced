import type { Sql, TransactionSql } from 'postgres';
import { normaliseStaffHoldAmount, type StaffHoldState } from '@intafaced/contracts';

/**
 * Staff hold rows and the ledger posts made for them (OPS-accounts-desk-01). The balance itself lives in the ledger
 * (`ops:hold:<holdNo>` pots); a row here records what svc-ops asked the ledger to do and what the ledger answered, so a
 * lost reply is settled by reading the ledger by key and never by guessing.
 */

export type MovementKind = 'place' | 'release' | 'confirm';
export type MovementStatus = 'settling' | 'posted' | 'refused' | 'pending_retry';
export type MovementCause = 'staff' | 'approval' | 'expiry';

export interface HoldRow {
  readonly holdNo: string;
  readonly placeKey: string;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly remaining: string;
  readonly state: StaffHoldState;
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly placedBy: string;
  readonly placedAt: string;
}

export interface MovementRow {
  readonly holdNo: string;
  readonly kind: MovementKind;
  /** Release number or confirm attempt, allocated once and stored before the post. Place is 1. */
  readonly no: string;
  readonly amount: string;
  readonly status: MovementStatus;
  readonly cause: MovementCause;
  /** The ledger idempotency key. */
  readonly ledgerKey: string;
  /** svc-ops' own replay key: the place key, `ops.hold.release:<approvalId>`, `ops.hold.confirm:<approvalId>` or `expiry:<holdNo>`. */
  readonly requestKey: string;
  readonly approvalId: string | null;
  readonly requesterId: string | null;
  readonly approverId: string | null;
  readonly expiresAt: string | null;
  /** The owner-named confirm account slug in force when a confirm was asked for; a retry posts the same body. */
  readonly confirmAccount: string | null;
  readonly txId: string | null;
  readonly code: string | null;
  /** Posts sent under the key. */
  readonly attempts: number;
  /** True once any post under the key ended without a definite answer: from then on only the ledger's book decides. */
  readonly uncertain: boolean;
  readonly at: string;
  readonly lastAttemptAt: string | null;
  /** When the answer was recorded; null while the movement is open. */
  readonly settledAt: string | null;
  /** When the settling worker last looked at the movement: it works through the oldest-looked-at first. */
  readonly checkedAt: string | null;
}

/** A movement refused `ledger.post_lost`, still worth reading again. */
export interface LostMovement {
  readonly holdNo: string;
  readonly requestKey: string;
}

export interface NewHold {
  readonly placeKey: string;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly reason: string;
  readonly expiresAt: string | null;
  readonly placedBy: string;
  readonly at: string;
}

export interface NewMovement {
  readonly kind: 'release' | 'confirm';
  readonly amount: string;
  readonly cause: MovementCause;
  readonly requestKey: string;
  readonly approvalId: string | null;
  readonly requesterId: string | null;
  readonly approverId: string | null;
  readonly expiresAt: string | null;
  readonly confirmAccount: string | null;
  readonly at: string;
  /** Builds the ledger key from the allocated number. */
  readonly ledgerKey: (no: string) => string;
}

export interface AttemptOutcome {
  readonly status: MovementStatus;
  readonly uncertain: boolean;
  readonly txId: string | null;
  readonly code: string | null;
  readonly at: string;
}

/** One hold, locked for the length of the callback: no other action on it runs until this one returns. */
export interface LockedHold {
  readonly hold: HoldRow;
  readonly movements: readonly MovementRow[];
  /** Store a new movement at `settling` with the next number for its kind. */
  addMovement(movement: NewMovement): Promise<MovementRow>;
  /** Record one post's answer for a movement, and the hold's new remaining amount and state. */
  settle(requestKey: string, outcome: AttemptOutcome, hold: { remaining: string; state: StaffHoldState }): Promise<void>;
  /** Count one more post sent under the movement's key. The movement is `settling` from here until its answer is recorded. */
  attempt(requestKey: string, at: string): Promise<void>;
  /** Note that the settling worker looked at the movement now. */
  check(requestKey: string, at: string): Promise<void>;
}

export interface StaffHoldStore {
  list(userId: string): Promise<{ hold: HoldRow; movements: MovementRow[] }[]>;
  /** The hold whose place key or movement replay key this is. */
  findByRequestKey(requestKey: string): Promise<{ hold: HoldRow; movement: MovementRow } | null>;
  /** Create a hold at `placing` with its place movement at `settling` (key `ops:hold:<holdNo>`), or return the one stored under the key. */
  placeIntent(hold: NewHold): Promise<{ hold: HoldRow; movement: MovementRow; created: boolean }>;
  lock<T>(holdNo: string, fn: (locked: LockedHold) => Promise<T>): Promise<T | null>;
  /**
   * Holds whose expiry has passed and that still hold something (`active` or `partially_released`), with no movement
   * open and no expiry release the ledger refused since the hold last changed.
   */
  expired(nowIso: string, limit: number): Promise<string[]>;
  /**
   * Holds with a movement that is `settling`, or `pending_retry` and due again at `nowIso` (`retryWaitMs`), the one looked
   * at longest ago first.
   */
  unsettled(nowIso: string, limit: number): Promise<string[]>;
  /**
   * Movements declared `ledger.post_lost` (uncertain) at or after `lostSince` and not looked at since `checkedBefore`, the
   * one looked at longest ago first.
   */
  lost(lostSince: string, checkedBefore: string, limit: number): Promise<LostMovement[]>;
}

const placeKey = (holdNo: string) => `ops:hold:${holdNo}`;

/**
 * How long a `pending_retry` movement (the posting freeze, or a request that never left this process) waits after its
 * `attempts`-th send before it is sent again: 5 s after the first, twice as long after each further one, up to a minute,
 * so a ledger that is down or misaddressed is not asked every tick. The SQL store applies the same rule in `unsettled`.
 */
export const RETRY_FIRST_WAIT_MS = 5_000;
export const RETRY_LONGEST_WAIT_MS = 60_000;
export const retryWaitMs = (attempts: number) => Math.min(RETRY_FIRST_WAIT_MS * 2 ** Math.max(0, attempts - 1), RETRY_LONGEST_WAIT_MS);
/** Whether a `pending_retry` movement has waited `retryWaitMs` since its last send (anything else is always due). */
export const retryDue = (m: MovementRow, nowMs: number) =>
  m.status !== 'pending_retry' || m.lastAttemptAt === null || Date.parse(m.lastAttemptAt) + retryWaitMs(m.attempts) <= nowMs;
/**
 * An expiry release the ledger refused is not tried again until another movement on the hold posts after it: a release
 * found in the book after it was declared lost changes what is held, so the next expiry release is sized from the
 * corrected amount.
 */
export const expiryBlocked = (movements: readonly MovementRow[]) =>
  movements.some(
    (e) =>
      e.cause === 'expiry' &&
      e.status === 'refused' &&
      !movements.some((m) => m.status === 'posted' && m.settledAt !== null && e.settledAt !== null && m.settledAt > e.settledAt),
  );

/* ------------------------------------------------------------------ memory */

export class MemoryStaffHoldStore implements StaffHoldStore {
  private holds = new Map<string, HoldRow>();
  private movements: MovementRow[] = [];
  private next = 1;
  private queues = new Map<string, Promise<unknown>>();

  async list(userId: string) {
    return [...this.holds.values()]
      .filter((h) => h.userId === userId)
      .sort((a, b) => Number(b.holdNo) - Number(a.holdNo))
      .map((hold) => ({ hold, movements: this.movements.filter((m) => m.holdNo === hold.holdNo) }));
  }

  async findByRequestKey(requestKey: string) {
    const movement = this.movements.find((m) => m.requestKey === requestKey);
    return movement ? { hold: this.holds.get(movement.holdNo)!, movement } : null;
  }

  async placeIntent(input: NewHold) {
    const found = await this.findByRequestKey(input.placeKey);
    if (found) return { ...found, created: false };
    const holdNo = String(this.next++);
    const hold: HoldRow = { ...input, holdNo, remaining: input.amount, state: 'placing', placedAt: input.at };
    const movement: MovementRow = {
      holdNo,
      kind: 'place',
      no: '1',
      amount: input.amount,
      status: 'settling',
      cause: 'staff',
      ledgerKey: placeKey(holdNo),
      requestKey: input.placeKey,
      approvalId: null,
      requesterId: input.placedBy,
      approverId: null,
      expiresAt: input.expiresAt,
      confirmAccount: null,
      txId: null,
      code: null,
      attempts: 0,
      uncertain: false,
      at: input.at,
      lastAttemptAt: null,
      settledAt: null,
      checkedAt: null,
    };
    this.holds.set(holdNo, hold);
    this.movements.push(movement);
    return { hold, movement, created: true };
  }

  lock<T>(holdNo: string, fn: (locked: LockedHold) => Promise<T>): Promise<T | null> {
    const prior = this.queues.get(holdNo) ?? Promise.resolve();
    const run = prior.then(async () => {
      const hold = this.holds.get(holdNo);
      if (!hold) return null;
      const update = (requestKey: string, patch: Partial<MovementRow>) => {
        this.movements = this.movements.map((m) => (m.requestKey === requestKey ? { ...m, ...patch } : m));
      };
      return fn({
        hold,
        movements: this.movements.filter((m) => m.holdNo === holdNo),
        addMovement: async (input) => {
          const no = String(this.movements.filter((m) => m.holdNo === holdNo && m.kind === input.kind).length + 1);
          const row: MovementRow = {
            holdNo,
            kind: input.kind,
            no,
            amount: input.amount,
            status: 'settling',
            cause: input.cause,
            ledgerKey: input.ledgerKey(no),
            requestKey: input.requestKey,
            approvalId: input.approvalId,
            requesterId: input.requesterId,
            approverId: input.approverId,
            expiresAt: input.expiresAt,
            confirmAccount: input.confirmAccount,
            txId: null,
            code: null,
            attempts: 0,
            uncertain: false,
            at: input.at,
            lastAttemptAt: null,
            settledAt: null,
            checkedAt: null,
          };
          this.movements.push(row);
          return row;
        },
        settle: async (requestKey, outcome, next) => {
          update(requestKey, {
            status: outcome.status,
            uncertain: outcome.uncertain,
            txId: outcome.txId,
            code: outcome.code,
            settledAt: outcome.at,
          });
          this.holds.set(holdNo, { ...this.holds.get(holdNo)!, remaining: next.remaining, state: next.state });
        },
        attempt: async (requestKey, at) => {
          const m = this.movements.find((r) => r.requestKey === requestKey)!;
          update(requestKey, { status: 'settling', attempts: m.attempts + 1, lastAttemptAt: at });
        },
        check: async (requestKey, at) => update(requestKey, { checkedAt: at }),
      });
    });
    this.queues.set(
      holdNo,
      run.catch(() => undefined),
    );
    return run;
  }

  async expired(nowIso: string, limit: number) {
    return [...this.holds.values()]
      .filter((h) => h.expiresAt !== null && h.expiresAt <= nowIso && (h.state === 'active' || h.state === 'partially_released'))
      .filter((h) => {
        const own = this.movements.filter((m) => m.holdNo === h.holdNo);
        return !own.some((m) => m.status === 'settling' || m.status === 'pending_retry') && !expiryBlocked(own);
      })
      .slice(0, limit)
      .map((h) => h.holdNo);
  }

  async unsettled(nowIso: string, limit: number) {
    const open = this.movements
      .filter((m) => (m.status === 'settling' || m.status === 'pending_retry') && retryDue(m, Date.parse(nowIso)))
      .sort((a, b) => (a.checkedAt ?? a.at).localeCompare(b.checkedAt ?? b.at));
    return [...new Set(open.map((m) => m.holdNo))].slice(0, limit);
  }

  async lost(lostSince: string, checkedBefore: string, limit: number) {
    return this.movements
      .filter((m) => m.status === 'refused' && m.code === 'ledger.post_lost' && m.uncertain)
      .filter((m) => m.settledAt !== null && m.settledAt >= lostSince)
      .filter((m) => m.checkedAt === null || m.checkedAt <= checkedBefore)
      .sort((a, b) => (a.checkedAt ?? a.settledAt!).localeCompare(b.checkedAt ?? b.settledAt!))
      .slice(0, limit)
      .map((m) => ({ holdNo: m.holdNo, requestKey: m.requestKey }));
  }
}

/* -------------------------------------------------------------------- sql */

type HoldDb = {
  hold_no: string;
  place_key: string;
  user_id: string;
  asset_id: string;
  amount: string;
  remaining: string;
  state: StaffHoldState;
  reason: string;
  expires_at: Date | string | null;
  placed_by: string;
  placed_at: Date | string;
};

type MovementDb = {
  hold_no: string;
  kind: MovementKind;
  no: string;
  amount: string;
  status: MovementStatus;
  cause: MovementCause;
  ledger_key: string;
  request_key: string;
  approval_id: string | null;
  requester_id: string | null;
  approver_id: string | null;
  expires_at: Date | string | null;
  confirm_account: string | null;
  tx_id: string | null;
  code: string | null;
  attempts: number;
  uncertain: boolean;
  created_at: Date | string;
  last_attempt_at: Date | string | null;
  settled_at: Date | string | null;
  checked_at: Date | string | null;
};

const isoOf = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : isoOf(v));

/** numeric(38,18) comes back padded ("40.000000000000000000"); the wire carries the plain decimal. */
const plainDecimal = normaliseStaffHoldAmount;

const holdOf = (r: HoldDb): HoldRow => ({
  holdNo: String(r.hold_no),
  placeKey: r.place_key,
  userId: r.user_id,
  assetId: r.asset_id,
  amount: plainDecimal(r.amount),
  remaining: plainDecimal(r.remaining),
  state: r.state,
  reason: r.reason,
  expiresAt: isoOrNull(r.expires_at),
  placedBy: r.placed_by,
  placedAt: isoOf(r.placed_at),
});

const movementOf = (r: MovementDb): MovementRow => ({
  holdNo: String(r.hold_no),
  kind: r.kind,
  no: String(r.no),
  amount: plainDecimal(r.amount),
  status: r.status,
  cause: r.cause,
  ledgerKey: r.ledger_key,
  requestKey: r.request_key,
  approvalId: r.approval_id,
  requesterId: r.requester_id,
  approverId: r.approver_id,
  expiresAt: isoOrNull(r.expires_at),
  confirmAccount: r.confirm_account,
  txId: r.tx_id,
  code: r.code,
  attempts: r.attempts,
  uncertain: r.uncertain,
  at: isoOf(r.created_at),
  lastAttemptAt: isoOrNull(r.last_attempt_at),
  settledAt: isoOrNull(r.settled_at),
  checkedAt: isoOrNull(r.checked_at),
});

const movementsOf = async (sql: Sql | TransactionSql, holdNos: readonly string[]): Promise<MovementRow[]> => {
  if (holdNos.length === 0) return [];
  const rows = await sql<MovementDb[]>`
    SELECT * FROM ops.staff_hold_movements WHERE hold_no IN ${sql(holdNos)} ORDER BY created_at, kind, no
  `;
  return rows.map(movementOf);
};

export class SqlStaffHoldStore implements StaffHoldStore {
  constructor(private readonly sql: Sql) {}

  async list(userId: string) {
    const holds = (await this.sql<HoldDb[]>`SELECT * FROM ops.staff_holds WHERE user_id = ${userId} ORDER BY hold_no DESC`).map(holdOf);
    const movements = await movementsOf(
      this.sql,
      holds.map((h) => h.holdNo),
    );
    return holds.map((hold) => ({ hold, movements: movements.filter((m) => m.holdNo === hold.holdNo) }));
  }

  async findByRequestKey(requestKey: string) {
    const rows = await this.sql<MovementDb[]>`SELECT * FROM ops.staff_hold_movements WHERE request_key = ${requestKey}`;
    if (!rows[0]) return null;
    const holds = await this.sql<HoldDb[]>`SELECT * FROM ops.staff_holds WHERE hold_no = ${rows[0].hold_no}`;
    return { hold: holdOf(holds[0]!), movement: movementOf(rows[0]) };
  }

  async placeIntent(input: NewHold) {
    return this.sql.begin(async (tx) => {
      // One place per key: the second of two racing requests waits here and then finds the first.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.staff_hold.place:${input.placeKey}`}))`;
      const prior = await tx<MovementDb[]>`SELECT * FROM ops.staff_hold_movements WHERE request_key = ${input.placeKey}`;
      if (prior[0]) {
        const holds = await tx<HoldDb[]>`SELECT * FROM ops.staff_holds WHERE hold_no = ${prior[0].hold_no}`;
        return { hold: holdOf(holds[0]!), movement: movementOf(prior[0]), created: false };
      }
      const holds = await tx<HoldDb[]>`
        INSERT INTO ops.staff_holds (place_key, user_id, asset_id, amount, remaining, state, reason, expires_at, placed_by, placed_at)
        VALUES (${input.placeKey}, ${input.userId}, ${input.assetId}, ${input.amount}, ${input.amount}, 'placing', ${input.reason},
          ${input.expiresAt}, ${input.placedBy}, ${input.at})
        RETURNING *
      `;
      const hold = holdOf(holds[0]!);
      const movements = await tx<MovementDb[]>`
        INSERT INTO ops.staff_hold_movements
          (hold_no, kind, no, amount, status, cause, ledger_key, request_key, requester_id, expires_at, created_at)
        VALUES (${hold.holdNo}, 'place', 1, ${input.amount}, 'settling', 'staff', ${placeKey(hold.holdNo)}, ${input.placeKey},
          ${input.placedBy}, ${input.expiresAt}, ${input.at})
        RETURNING *
      `;
      return { hold, movement: movementOf(movements[0]!), created: true };
    }) as Promise<{ hold: HoldRow; movement: MovementRow; created: boolean }>;
  }

  /**
   * The hold row is locked FOR UPDATE for the whole callback, including the call to identity that spends an approval
   * (bounded by the approval client's timeout). The ledger post itself runs outside the lock, between two of these.
   */
  async lock<T>(holdNo: string, fn: (locked: LockedHold) => Promise<T>): Promise<T | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<HoldDb[]>`SELECT * FROM ops.staff_holds WHERE hold_no = ${holdNo} FOR UPDATE`;
      if (!rows[0]) return null;
      return fn({
        hold: holdOf(rows[0]),
        movements: await movementsOf(tx, [holdNo]),
        addMovement: async (input) => {
          const counted = await tx<{ n: string }[]>`
            SELECT count(*)::text AS n FROM ops.staff_hold_movements WHERE hold_no = ${holdNo} AND kind = ${input.kind}
          `;
          const no = String(Number(counted[0]!.n) + 1);
          const inserted = await tx<MovementDb[]>`
            INSERT INTO ops.staff_hold_movements
              (hold_no, kind, no, amount, status, cause, ledger_key, request_key, approval_id, requester_id, approver_id, expires_at,
               confirm_account, created_at)
            VALUES (${holdNo}, ${input.kind}, ${no}, ${input.amount}, 'settling', ${input.cause}, ${input.ledgerKey(no)}, ${input.requestKey},
              ${input.approvalId}, ${input.requesterId}, ${input.approverId}, ${input.expiresAt}, ${input.confirmAccount}, ${input.at})
            RETURNING *
          `;
          return movementOf(inserted[0]!);
        },
        settle: async (requestKey, outcome, next) => {
          await tx`
            UPDATE ops.staff_hold_movements
               SET status = ${outcome.status}, uncertain = ${outcome.uncertain}, tx_id = ${outcome.txId}, code = ${outcome.code},
                   settled_at = ${outcome.at}
             WHERE request_key = ${requestKey}
          `;
          await tx`UPDATE ops.staff_holds SET remaining = ${next.remaining}, state = ${next.state} WHERE hold_no = ${holdNo}`;
        },
        attempt: async (requestKey, at) => {
          await tx`
            UPDATE ops.staff_hold_movements
               SET status = 'settling', attempts = attempts + 1, last_attempt_at = ${at}
             WHERE request_key = ${requestKey}
          `;
        },
        check: async (requestKey, at) => {
          await tx`UPDATE ops.staff_hold_movements SET checked_at = ${at} WHERE request_key = ${requestKey}`;
        },
      });
    }) as Promise<T | null>;
  }

  async expired(nowIso: string, limit: number) {
    const rows = await this.sql<{ hold_no: string }[]>`
      SELECT hold_no FROM ops.staff_holds
       WHERE expires_at IS NOT NULL AND expires_at <= ${nowIso} AND state IN ('active', 'partially_released')
         AND NOT EXISTS (
           SELECT 1 FROM ops.staff_hold_movements m WHERE m.hold_no = staff_holds.hold_no AND m.status IN ('settling', 'pending_retry')
         )
         AND NOT EXISTS (
           SELECT 1 FROM ops.staff_hold_movements e
            WHERE e.hold_no = staff_holds.hold_no AND e.cause = 'expiry' AND e.status = 'refused'
              AND NOT EXISTS (
                SELECT 1 FROM ops.staff_hold_movements p
                 WHERE p.hold_no = e.hold_no AND p.status = 'posted' AND p.settled_at > e.settled_at
              )
         )
       ORDER BY expires_at LIMIT ${limit}
    `;
    return rows.map((r) => String(r.hold_no));
  }

  async unsettled(nowIso: string, limit: number) {
    // retryWaitMs in SQL: 5 s doubled per send after the first, at most 60 s.
    const rows = await this.sql<{ hold_no: string }[]>`
      SELECT hold_no FROM ops.staff_hold_movements
       WHERE status = 'settling'
          OR (status = 'pending_retry' AND (last_attempt_at IS NULL OR last_attempt_at
                + make_interval(secs => least(${RETRY_FIRST_WAIT_MS / 1000} * power(2, greatest(attempts - 1, 0)), ${RETRY_LONGEST_WAIT_MS / 1000}))
                <= ${nowIso}::timestamptz))
       GROUP BY hold_no ORDER BY min(coalesce(checked_at, created_at)), hold_no LIMIT ${limit}
    `;
    return rows.map((r) => String(r.hold_no));
  }

  async lost(lostSince: string, checkedBefore: string, limit: number) {
    const rows = await this.sql<{ hold_no: string; request_key: string }[]>`
      SELECT hold_no, request_key FROM ops.staff_hold_movements
       WHERE status = 'refused' AND code = 'ledger.post_lost' AND uncertain AND settled_at >= ${lostSince}
         AND (checked_at IS NULL OR checked_at <= ${checkedBefore})
       ORDER BY coalesce(checked_at, settled_at), hold_no LIMIT ${limit}
    `;
    return rows.map((r) => ({ holdNo: String(r.hold_no), requestKey: r.request_key }));
  }
}
