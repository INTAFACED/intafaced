import type { Sql, TransactionSql } from 'postgres';
import type { StaffHoldState } from '@intafaced/contracts';

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
  /** Count one more post sent under the movement's key. */
  attempt(requestKey: string, at: string): Promise<void>;
}

export interface StaffHoldStore {
  list(userId: string): Promise<{ hold: HoldRow; movements: MovementRow[] }[]>;
  /** The hold whose place key or movement replay key this is. */
  findByRequestKey(requestKey: string): Promise<{ hold: HoldRow; movement: MovementRow } | null>;
  /** Create a hold at `placing` with its place movement at `settling` (key `ops:hold:<holdNo>`), or return the one stored under the key. */
  placeIntent(hold: NewHold): Promise<{ hold: HoldRow; movement: MovementRow; created: boolean }>;
  lock<T>(holdNo: string, fn: (locked: LockedHold) => Promise<T>): Promise<T | null>;
  /** Holds whose expiry has passed and that still hold something (`active` or `partially_released`). */
  expired(nowIso: string, limit: number): Promise<string[]>;
  /** Holds with a movement that is `settling` or `pending_retry`. */
  unsettled(limit: number): Promise<string[]>;
}

const placeKey = (holdNo: string) => `ops:hold:${holdNo}`;

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
          };
          this.movements.push(row);
          return row;
        },
        settle: async (requestKey, outcome, next) => {
          update(requestKey, { status: outcome.status, uncertain: outcome.uncertain, txId: outcome.txId, code: outcome.code });
          this.holds.set(holdNo, { ...this.holds.get(holdNo)!, remaining: next.remaining, state: next.state });
        },
        attempt: async (requestKey, at) => {
          const m = this.movements.find((r) => r.requestKey === requestKey)!;
          update(requestKey, { attempts: m.attempts + 1, lastAttemptAt: at });
        },
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
      .slice(0, limit)
      .map((h) => h.holdNo);
  }

  async unsettled(limit: number) {
    return [...new Set(this.movements.filter((m) => m.status === 'settling' || m.status === 'pending_retry').map((m) => m.holdNo))].slice(
      0,
      limit,
    );
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
};

const isoOf = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : isoOf(v));

/** numeric(38,18) comes back padded ("40.000000000000000000"); the wire carries the plain decimal. */
export function plainDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

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
            UPDATE ops.staff_hold_movements SET attempts = attempts + 1, last_attempt_at = ${at} WHERE request_key = ${requestKey}
          `;
        },
      });
    }) as Promise<T | null>;
  }

  async expired(nowIso: string, limit: number) {
    const rows = await this.sql<{ hold_no: string }[]>`
      SELECT hold_no FROM ops.staff_holds
       WHERE expires_at IS NOT NULL AND expires_at <= ${nowIso} AND state IN ('active', 'partially_released')
       ORDER BY expires_at LIMIT ${limit}
    `;
    return rows.map((r) => String(r.hold_no));
  }

  async unsettled(limit: number) {
    const rows = await this.sql<{ hold_no: string }[]>`
      SELECT DISTINCT hold_no FROM ops.staff_hold_movements WHERE status IN ('settling', 'pending_retry') ORDER BY hold_no LIMIT ${limit}
    `;
    return rows.map((r) => String(r.hold_no));
  }
}
