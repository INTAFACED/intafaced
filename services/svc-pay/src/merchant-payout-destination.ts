import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { assertPayoutDestinationKind, DestinationKindError } from './payout-destination.js';

/**
 * Persisted merchant payout destination — the ref a later `payoutSettlement`
 * must already have BEFORE `withdrawHold`.
 *
 * Shape + kind go through `assertPayoutDestinationKind` (IBAN / IFSC / EVM).
 * This file does not live-wire `bank-payout` (that adapter stays `mode: absent`)
 * and does not invent a PSP.
 *
 * A destination is in one of three states (J-merchant-02 #5):
 * - `unverified`: saved by the owner (`merchant.payoutDestinations.add`) or by a
 *   payout before D-142. `require` refuses it (`pay.payout_destination_unverified`).
 * - `held`: verified with a fresh step-up, waiting out the hold. Stored FAIL
 *   CLOSED as `verified = false` with `verified_at` and `activates_at` set
 *   (`verified_at + PAY_DESTINATION_HOLD_SECONDS`), so code that reads only
 *   `verified` (an older build, a rollback) never pays it. `require` refuses
 *   it (`pay.payout_destination_held`) until then.
 * - `active`: `verified = true`. A held row is flipped to `verified = true`
 *   lazily, under its row lock, once `activates_at` has passed (on require,
 *   read, the change transaction and the list), the way a pending change is
 *   promoted. `seedVerified` (test and recovery seam) writes it active at once.
 * Unverified is `verified = false AND activates_at IS NULL`.
 * Settlement payout never calls a writer.
 */

export const PAY_PAYOUT_DESTINATION_MISSING = 'pay.payout_destination_missing' as const;

export class PayoutDestinationMissingError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_MISSING;
  constructor(merchantId: string, railId: string) {
    super(`Merchant ${merchantId} has no persisted payout destination for rail ${railId}`);
    this.name = 'PayoutDestinationMissingError';
  }
}

export const PAY_PAYOUT_DESTINATION_UNVERIFIED = 'pay.payout_destination_unverified' as const;
export const PAY_PAYOUT_DESTINATION_HELD = 'pay.payout_destination_held' as const;

/** The rail's destination is saved but not verified with a step-up. Nothing is paid to it. */
export class PayoutDestinationUnverifiedError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_UNVERIFIED;
  constructor(merchantId: string, railId: string) {
    super(`Merchant ${merchantId}'s payout destination for rail ${railId} is not verified`);
    this.name = 'PayoutDestinationUnverifiedError';
  }
}

/** The rail's destination is verified and still inside its hold. Nothing is paid to it before `activatesAt`. */
export class PayoutDestinationHeldError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_HELD;
  constructor(
    merchantId: string,
    railId: string,
    readonly activatesAt: Date,
  ) {
    super(`Merchant ${merchantId}'s payout destination for rail ${railId} is held until ${activatesAt.toISOString()}`);
    this.name = 'PayoutDestinationHeldError';
  }
}

export const PAY_PAYOUT_DESTINATION_IN_FLIGHT = 'pay.payout_destination_in_flight' as const;

/** An unverified row is not replaced while a payout that still names it has not finished (the same rule as remove). */
export class PayoutDestinationInFlightError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_IN_FLIGHT;
  constructor(merchantId: string, railId: string) {
    super(`Merchant ${merchantId}'s payout destination for rail ${railId} is named by a payout that has not finished`);
    this.name = 'PayoutDestinationInFlightError';
  }
}

export const PAY_PAYOUT_DESTINATION_CONFLICT = 'pay.payout_destination_conflict' as const;

/** Two first saves on one rail raced; the row the other one wrote stands, and this one is refused. */
export class PayoutDestinationConflictError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_CONFLICT;
  constructor(merchantId: string, railId: string) {
    super(`Merchant ${merchantId}'s payout destination for rail ${railId} was saved by another request at the same time`);
    this.name = 'PayoutDestinationConflictError';
  }
}

/** A unique violation (two first inserts on one merchant and rail) becomes the typed conflict. */
async function insertOnce(merchantId: string, railId: string, insert: () => Promise<unknown>): Promise<void> {
  try {
    await insert();
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '23505') throw new PayoutDestinationConflictError(merchantId, railId);
    throw err;
  }
}

export const PAY_PAYOUT_DESTINATION_NOT_FOUND = 'pay.payout_destination_not_found' as const;
export const PAY_PAYOUT_DESTINATION_NOT_HELD = 'pay.payout_destination_not_held' as const;

/** No destination with this id for this merchant. The same answer as a foreign id. */
export class PayoutDestinationNotFoundError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_NOT_FOUND;
  constructor() {
    super('payout destination not found');
    this.name = 'PayoutDestinationNotFoundError';
  }
}

/** Cancel is for a hold only: an active destination (with or without a pending change) has none to cancel. */
export class PayoutDestinationNotHeldError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_NOT_HELD;
  constructor(merchantId: string, railId: string) {
    super(`Merchant ${merchantId}'s payout destination for rail ${railId} is active; there is no hold to cancel`);
    this.name = 'PayoutDestinationNotHeldError';
  }
}

/** What cancelling a hold did: `changed` is false when the destination was already unverified. */
export type DestinationHoldCancel = { readonly changed: boolean; readonly railId: string; readonly kind: string; readonly ref: string };

export type PayoutDestination = { kind: string; ref: string };

export type DestinationLifecycle = 'unverified' | 'held' | 'active';

/** Unverified, held until `activatesAt`, or active. `activatesAt` is null for a row with no hold to wait out. */
export function destinationLifecycle(
  row: { verified: boolean; activatesAt: Date | null },
  now: Date,
): { state: DestinationLifecycle; activatesAt: Date | null } {
  if (!row.verified) return { state: 'unverified', activatesAt: null };
  if (row.activatesAt && row.activatesAt.getTime() > now.getTime()) return { state: 'held', activatesAt: row.activatesAt };
  return { state: 'active', activatesAt: null };
}

/** The state of a stored row from its columns: held is `verified = false` with `activates_at` set (fail closed). */
export function lifecycleOfColumns(
  row: { verified: boolean; activates_at: Date | null },
  now: Date,
): { state: DestinationLifecycle; activatesAt: Date | null } {
  return destinationLifecycle({ verified: row.verified || row.activates_at !== null, activatesAt: row.activates_at }, now);
}

/** The payable destination, or the typed refusal for a missing, unverified or held one. */
function payable(merchantId: string, railId: string, row: DestinationState | null, now: Date): PayoutDestination {
  if (!row) throw new PayoutDestinationMissingError(merchantId, railId);
  const life = destinationLifecycle(row, now);
  if (life.state === 'unverified') throw new PayoutDestinationUnverifiedError(merchantId, railId);
  if (life.state === 'held') throw new PayoutDestinationHeldError(merchantId, railId, life.activatesAt!);
  return { kind: row.kind, ref: row.ref };
}

export type DestinationPending = { kind: string; ref: string; activatesAt: Date };

export type DestinationState = {
  kind: string;
  ref: string;
  /** Verified with a step-up: held (while `activatesAt` is ahead) or active. False only for an unverified row. */
  verified: boolean;
  /** When a verified row becomes payable. Null: no hold to wait out. Meaningless while unverified. */
  activatesAt: Date | null;
  pending: DestinationPending | null;
};

export interface DestinationWriter {
  /** Save the rail's first destination, unverified. Only when the rail has no row. */
  insertUnverified(input: { kind: string; ref: string }): Promise<void>;
  /**
   * Replace an unverified row's kind and ref. Never touches a verified row. Refused
   * (`PayoutDestinationInFlightError`) while a payout still names the old ref, as remove is. The default mark is
   * cleared: it was the owner's choice of the old address, not of this one.
   */
  replaceUnverified(input: { kind: string; ref: string }): Promise<void>;
  /** A new row, verified and held until `activatesAt` (stored `verified = false`, fail closed). */
  insertVerified(input: { kind: string; ref: string; verifiedAt: Date; activatesAt: Date }): Promise<void>;
  /**
   * Verify an unverified or held row (with the kind and ref the step-up covered); it is held, again, until
   * `activatesAt`. Never touches an active row.
   */
  verifyExisting(input: { kind: string; ref: string; verifiedAt: Date; activatesAt: Date }): Promise<void>;
  stagePending(input: { kind: string; ref: string; activatesAt: Date }): Promise<void>;
}

export type MerchantPayoutDestinations = {
  /** Unverified row. Not payable. Not the merchant change procedure. */
  persist(input: { merchantId: string; railId: string; kind: string; ref: string; connection?: Sql }): Promise<PayoutDestination>;
  /** Payable row for tests and for a payout that must already have a verified dest. */
  seedVerified(input: { merchantId: string; railId: string; kind: string; ref: string; connection?: Sql }): Promise<PayoutDestination>;
  /**
   * Active verified destination, promoting a pending change whose hold has passed.
   * Missing, unverified and held each refuse with their own typed error.
   */
  require(input: { merchantId: string; railId: string; connection?: Sql }): Promise<PayoutDestination>;
  read(input: { merchantId: string; railId: string; connection?: Sql }): Promise<DestinationState | null>;
  transaction(
    merchantId: string,
    railId: string,
    fn: (row: DestinationState | null, write: DestinationWriter) => Promise<void>,
  ): Promise<void>;
  /**
   * Move a held destination back to unverified (`activates_at` and `verified_at` cleared) under its row lock. An
   * unverified one is left as it is (`changed: false`). An active one, including one whose hold has just passed or
   * one with a pending change, refuses `PayoutDestinationNotHeldError`. A missing or foreign id refuses
   * `PayoutDestinationNotFoundError`. Memory ids are `<merchantId>:<railId>`.
   */
  cancelHold(input: { merchantId: string; destinationId: string }): Promise<DestinationHoldCancel>;
};

/** Assert kind+shape. Does not register or enable any rail. */
export function assertPersistableDestination(railId: string, destination: { kind: string; ref: string }): PayoutDestination {
  try {
    assertPayoutDestinationKind(railId, destination);
  } catch (err) {
    if (err instanceof DestinationKindError) throw err;
    throw err;
  }
  return { kind: destination.kind.trim(), ref: destination.ref.trim() };
}

function emptyBook(): MerchantPayoutDestinations {
  return {
    async persist(input) {
      return assertPersistableDestination(input.railId, input);
    },
    async seedVerified(input) {
      return assertPersistableDestination(input.railId, input);
    },
    async require(input) {
      throw new PayoutDestinationMissingError(input.merchantId, input.railId);
    },
    async read() {
      return null;
    },
    async transaction() {
      throw new PayoutDestinationMissingError('none', 'none');
    },
    async cancelHold() {
      throw new PayoutDestinationNotFoundError();
    },
  };
}

/**
 * Router-test default: assert on persist, never invent a stored ref.
 * A later payout without a dest refuses closed.
 */
export function assertOnlyPayoutDestinations(): MerchantPayoutDestinations {
  return emptyBook();
}

type MemoryRow = DestinationState;

/** In-memory store for tests. `require` refuses until a verified row exists. */
export function memoryPayoutDestinations(clock: () => Date = () => new Date()): MerchantPayoutDestinations {
  const rows = new Map<string, MemoryRow>();
  const key = (merchantId: string, railId: string) => `${merchantId}:${railId}`;
  const promote = (row: MemoryRow): MemoryRow => {
    if (!row.verified || !row.pending || row.pending.activatesAt.getTime() > clock().getTime()) return row;
    return { kind: row.pending.kind, ref: row.pending.ref, verified: true, activatesAt: null, pending: null };
  };
  return {
    async persist(input) {
      const dest = assertPersistableDestination(input.railId, input);
      rows.set(key(input.merchantId, input.railId), { ...dest, verified: false, activatesAt: null, pending: null });
      return dest;
    },
    async seedVerified(input) {
      const dest = assertPersistableDestination(input.railId, input);
      rows.set(key(input.merchantId, input.railId), { ...dest, verified: true, activatesAt: null, pending: null });
      return dest;
    },
    async require(input) {
      const current = rows.get(key(input.merchantId, input.railId));
      const row = current ? promote(current) : null;
      if (row) rows.set(key(input.merchantId, input.railId), row);
      return payable(input.merchantId, input.railId, row, clock());
    },
    async read(input) {
      const current = rows.get(key(input.merchantId, input.railId));
      if (!current) return null;
      const row = promote(current);
      rows.set(key(input.merchantId, input.railId), row);
      return row;
    },
    async transaction(merchantId, railId, fn) {
      const id = key(merchantId, railId);
      const stored = rows.get(id) ?? null;
      const current = stored ? promote(stored) : null;
      if (current) rows.set(id, current);
      let next = current;
      const write: DestinationWriter = {
        async insertUnverified(input) {
          if (next) throw new PayoutDestinationMissingError(merchantId, railId);
          next = { kind: input.kind, ref: input.ref, verified: false, activatesAt: null, pending: null };
        },
        async replaceUnverified(input) {
          if (!next || next.verified) throw new PayoutDestinationMissingError(merchantId, railId);
          next = { kind: input.kind, ref: input.ref, verified: false, activatesAt: null, pending: null };
        },
        async insertVerified(input) {
          if (next) throw new PayoutDestinationMissingError(merchantId, railId);
          next = { kind: input.kind, ref: input.ref, verified: true, activatesAt: input.activatesAt, pending: null };
        },
        async verifyExisting(input) {
          if (!next || destinationLifecycle(next, clock()).state === 'active') throw new PayoutDestinationMissingError(merchantId, railId);
          next = { kind: input.kind, ref: input.ref, verified: true, activatesAt: input.activatesAt, pending: null };
        },
        async stagePending(input) {
          if (!next || destinationLifecycle(next, clock()).state !== 'active') throw new PayoutDestinationMissingError(merchantId, railId);
          next = { ...next, pending: input };
        },
      };
      await fn(current, write);
      if (next) rows.set(id, next);
    },
    async cancelHold(input) {
      const row = rows.get(input.destinationId);
      const railId = input.destinationId.slice(input.merchantId.length + 1);
      if (!row || !input.destinationId.startsWith(`${input.merchantId}:`)) throw new PayoutDestinationNotFoundError();
      const life = destinationLifecycle(promote(row), clock());
      const out = { railId, kind: row.kind, ref: row.ref };
      if (life.state === 'unverified') return { ...out, changed: false };
      if (life.state === 'active') throw new PayoutDestinationNotHeldError(input.merchantId, railId);
      rows.set(input.destinationId, { ...row, verified: false, activatesAt: null, pending: null });
      return { ...out, changed: true };
    },
  };
}

type DestinationSqlRow = {
  kind: string;
  ref: string;
  verified: boolean;
  activates_at: Date | null;
  pending_kind: string | null;
  pending_ref: string | null;
  pending_activates_at: Date | null;
};

function toState(row: DestinationSqlRow, now: Date): DestinationState {
  const pending =
    row.pending_kind && row.pending_ref && row.pending_activates_at
      ? { kind: row.pending_kind, ref: row.pending_ref, activatesAt: row.pending_activates_at }
      : null;
  if (row.verified && pending && pending.activatesAt.getTime() <= now.getTime()) {
    return { kind: pending.kind, ref: pending.ref, verified: true, activatesAt: null, pending: null };
  }
  // Held is stored `verified = false` with `activates_at` set; it is verified all the same.
  return { kind: row.kind, ref: row.ref, verified: row.verified || row.activates_at !== null, activatesAt: row.activates_at, pending };
}

export class MerchantPayoutDestinationStore implements MerchantPayoutDestinations {
  constructor(
    private readonly sql: Sql,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async persist(input: { merchantId: string; railId: string; kind: string; ref: string; connection?: Sql }): Promise<PayoutDestination> {
    const dest = assertPersistableDestination(input.railId, input);
    await (input.connection ?? this.sql)`
      INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified)
      VALUES (${input.merchantId}, ${input.railId}, ${dest.kind}, ${dest.ref}, false)
      ON CONFLICT (merchant_id, rail_id)
      DO UPDATE SET kind = excluded.kind,
                    ref = excluded.ref,
                    verified = false,
                    verified_at = NULL,
                    activates_at = NULL,
                    pending_kind = NULL,
                    pending_ref = NULL,
                    pending_activates_at = NULL,
                    updated_at = now()
    `;
    return dest;
  }

  async seedVerified(input: {
    merchantId: string;
    railId: string;
    kind: string;
    ref: string;
    connection?: Sql;
  }): Promise<PayoutDestination> {
    const dest = assertPersistableDestination(input.railId, input);
    const now = this.clock();
    await (input.connection ?? this.sql)`
      INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified, verified_at)
      VALUES (${input.merchantId}, ${input.railId}, ${dest.kind}, ${dest.ref}, true, ${now})
      ON CONFLICT (merchant_id, rail_id)
      DO UPDATE SET kind = excluded.kind,
                    ref = excluded.ref,
                    verified = true,
                    verified_at = ${now},
                    activates_at = NULL,
                    pending_kind = NULL,
                    pending_ref = NULL,
                    pending_activates_at = NULL,
                    updated_at = now()
    `;
    return dest;
  }

  async require(input: { merchantId: string; railId: string; connection?: Sql }): Promise<PayoutDestination> {
    const row = await this.promote(input.merchantId, input.railId, input.connection);
    return payable(input.merchantId, input.railId, row, this.clock());
  }

  async read(input: { merchantId: string; railId: string; connection?: Sql }): Promise<DestinationState | null> {
    return this.promote(input.merchantId, input.railId, input.connection);
  }

  async transaction(
    merchantId: string,
    railId: string,
    fn: (row: DestinationState | null, write: DestinationWriter) => Promise<void>,
  ): Promise<void> {
    await transaction(this.sql, async (tx) => {
      const locked = await tx<DestinationSqlRow[]>`
        SELECT kind, ref, verified, activates_at, pending_kind, pending_ref, pending_activates_at
          FROM pay.merchant_payout_destinations
         WHERE merchant_id = ${merchantId} AND rail_id = ${railId}
         FOR UPDATE
      `;
      const now = this.clock();
      const due = (at: Date | null) => at !== null && at.getTime() <= now.getTime();
      const lockedRow = locked[0];
      if (
        lockedRow &&
        ((lockedRow.verified && due(lockedRow.pending_activates_at)) || (!lockedRow.verified && due(lockedRow.activates_at)))
      ) {
        await this.applyPromotion(tx, merchantId, railId, now);
      }
      const fresh = await tx<DestinationSqlRow[]>`
        SELECT kind, ref, verified, activates_at, pending_kind, pending_ref, pending_activates_at
          FROM pay.merchant_payout_destinations
         WHERE merchant_id = ${merchantId} AND rail_id = ${railId}
         FOR UPDATE
      `;
      const row = fresh[0] ? toState(fresh[0], now) : null;
      const write: DestinationWriter = {
        async insertUnverified(input) {
          await insertOnce(
            merchantId,
            railId,
            () => tx`
              INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified)
              VALUES (${merchantId}, ${railId}, ${input.kind}, ${input.ref}, false)
            `,
          );
        },
        async replaceUnverified(input) {
          const old = fresh[0];
          if (!old || old.verified || old.activates_at !== null) throw new PayoutDestinationMissingError(merchantId, railId);
          const live = await tx<Array<{ live: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pay.control_payout_approvals a
               WHERE a.merchant_id = ${merchantId}
                 AND a.rail_id = ${railId}
                 AND a.destination_kind = ${old.kind}
                 AND a.destination_ref = ${old.ref}
                 AND a.status IN ('pending', 'approved')
                 AND a.expires_at > now()
            ) OR EXISTS (
              SELECT 1 FROM pay.payout_admissions p
               WHERE p.merchant_id = ${merchantId}
                 AND p.rail_id = ${railId}
                 AND p.destination_kind = ${old.kind}
                 AND p.destination_ref = ${old.ref}
                 AND NOT EXISTS (
                   SELECT 1 FROM pay.payout_outcomes o
                    WHERE o.admission_id = p.id
                      AND o.kind IN ('settled', 'reversed', 'identity_cancelled', 'rail_refused')
                 )
            ) AS live
          `;
          if (live[0]?.live) throw new PayoutDestinationInFlightError(merchantId, railId);
          const updated = await tx`
            UPDATE pay.merchant_payout_destinations
               SET kind = ${input.kind},
                   ref = ${input.ref},
                   is_default = false,
                   updated_at = now()
             WHERE merchant_id = ${merchantId} AND rail_id = ${railId} AND verified = false AND activates_at IS NULL
          `;
          if (updated.count !== 1) throw new PayoutDestinationMissingError(merchantId, railId);
        },
        async insertVerified(input) {
          await insertOnce(
            merchantId,
            railId,
            () => tx`
              INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified, verified_at, activates_at)
              VALUES (${merchantId}, ${railId}, ${input.kind}, ${input.ref}, false, ${input.verifiedAt}, ${input.activatesAt})
            `,
          );
        },
        async verifyExisting(input) {
          const updated = await tx`
            UPDATE pay.merchant_payout_destinations
               SET kind = ${input.kind},
                   ref = ${input.ref},
                   verified = false,
                   verified_at = ${input.verifiedAt},
                   activates_at = ${input.activatesAt},
                   pending_kind = NULL,
                   pending_ref = NULL,
                   pending_activates_at = NULL,
                   updated_at = now()
             WHERE merchant_id = ${merchantId} AND rail_id = ${railId} AND verified = false
          `;
          if (updated.count !== 1) throw new PayoutDestinationMissingError(merchantId, railId);
        },
        async stagePending(input) {
          const updated = await tx`
            UPDATE pay.merchant_payout_destinations
               SET pending_kind = ${input.kind},
                   pending_ref = ${input.ref},
                   pending_activates_at = ${input.activatesAt},
                   updated_at = now()
             WHERE merchant_id = ${merchantId} AND rail_id = ${railId} AND verified = true
          `;
          if (updated.count !== 1) throw new PayoutDestinationMissingError(merchantId, railId);
        },
      };
      await fn(row, write);
    });
  }

  async cancelHold(input: { merchantId: string; destinationId: string }): Promise<DestinationHoldCancel> {
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<Array<{ rail_id: string; kind: string; ref: string; verified: boolean; activates_at: Date | null }>>`
        SELECT rail_id, kind, ref, verified, activates_at
          FROM pay.merchant_payout_destinations
         WHERE id = ${input.destinationId} AND merchant_id = ${input.merchantId}
         FOR UPDATE
      `;
      if (!row) throw new PayoutDestinationNotFoundError();
      // A verified row is active whatever its activates_at says (a replica with a clock ahead may have promoted it).
      if (row.verified) throw new PayoutDestinationNotHeldError(input.merchantId, row.rail_id);
      const out = { railId: row.rail_id, kind: row.kind, ref: row.ref };
      const life = lifecycleOfColumns(row, this.clock());
      if (life.state === 'unverified') return { ...out, changed: false };
      // Active (or a hold that has just passed, which the next read promotes): nothing to cancel; nothing written.
      if (life.state === 'active') throw new PayoutDestinationNotHeldError(input.merchantId, row.rail_id);
      const updated = await tx`
        UPDATE pay.merchant_payout_destinations
           SET activates_at = NULL,
               verified_at = NULL,
               updated_at = now()
         WHERE id = ${input.destinationId}
           AND merchant_id = ${input.merchantId}
           AND verified = false
           AND activates_at IS NOT NULL
      `;
      // Under the row lock nothing else can change it; a miss means it is no longer held.
      if (updated.count !== 1) throw new PayoutDestinationNotHeldError(input.merchantId, row.rail_id);
      return { ...out, changed: true };
    });
  }

  private async promote(merchantId: string, railId: string, connection?: Sql): Promise<DestinationState | null> {
    const sql = connection ?? this.sql;
    const now = this.clock();
    await this.applyPromotion(sql, merchantId, railId, now);
    const rows = await sql<DestinationSqlRow[]>`
      SELECT kind, ref, verified, activates_at, pending_kind, pending_ref, pending_activates_at
        FROM pay.merchant_payout_destinations
       WHERE merchant_id = ${merchantId} AND rail_id = ${railId}
    `;
    const row = rows[0];
    if (!row) return null;
    return toState(row, now);
  }

  private async applyPromotion(sql: Sql, merchantId: string, railId: string, now: Date): Promise<void> {
    await sql`
      UPDATE pay.merchant_payout_destinations
         SET kind = pending_kind,
             ref = pending_ref,
             pending_kind = NULL,
             pending_ref = NULL,
             pending_activates_at = NULL,
             verified = true,
             verified_at = ${now},
             activates_at = NULL,
             updated_at = now()
       WHERE merchant_id = ${merchantId}
         AND rail_id = ${railId}
         AND verified = true
         AND pending_activates_at IS NOT NULL
         AND pending_activates_at <= ${now}
    `;
    // A held row whose hold has passed becomes active: only now is `verified` true.
    await sql`
      UPDATE pay.merchant_payout_destinations
         SET verified = true,
             updated_at = now()
       WHERE merchant_id = ${merchantId}
         AND rail_id = ${railId}
         AND verified = false
         AND activates_at IS NOT NULL
         AND activates_at <= ${now}
    `;
  }
}

/**
 * Promote every held destination of one merchant whose hold has passed (`verified` becomes true), so the list and the
 * remove guard read the stored truth. The UPDATE takes each row's lock.
 */
export async function promoteDueHeldDestinations(sql: Sql, merchantId: string, now: Date): Promise<void> {
  await sql`
    UPDATE pay.merchant_payout_destinations
       SET verified = true,
           updated_at = now()
     WHERE merchant_id = ${merchantId}
       AND verified = false
       AND activates_at IS NOT NULL
       AND activates_at <= ${now}
  `;
}
