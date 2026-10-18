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
 * `verified` is the payable flag. Rows saved by payouts before D-142 are
 * unverified and `require` refuses them. `persist` still writes that
 * unverified shape for callers that only need a row. `seedVerified` is the
 * test and recovery seam that marks a row payable without the merchant
 * procedure. Settlement payout never calls either writer.
 */

export const PAY_PAYOUT_DESTINATION_MISSING = 'pay.payout_destination_missing' as const;

export class PayoutDestinationMissingError extends Error {
  readonly code = PAY_PAYOUT_DESTINATION_MISSING;
  constructor(merchantId: string, railId: string) {
    super(`Merchant ${merchantId} has no persisted payout destination for rail ${railId}`);
    this.name = 'PayoutDestinationMissingError';
  }
}

export type PayoutDestination = { kind: string; ref: string };

export type DestinationPending = { kind: string; ref: string; activatesAt: Date };

export type DestinationState = {
  kind: string;
  ref: string;
  verified: boolean;
  pending: DestinationPending | null;
};

export interface DestinationWriter {
  insertVerified(input: { kind: string; ref: string; verifiedAt: Date }): Promise<void>;
  /** Replace an unverified row with the first verified destination. */
  verifyExisting(input: { kind: string; ref: string; verifiedAt: Date }): Promise<void>;
  stagePending(input: { kind: string; ref: string; activatesAt: Date }): Promise<void>;
}

export type MerchantPayoutDestinations = {
  /** Unverified row. Not payable. Not the merchant change procedure. */
  persist(input: { merchantId: string; railId: string; kind: string; ref: string; connection?: Sql }): Promise<PayoutDestination>;
  /** Payable row for tests and for a payout that must already have a verified dest. */
  seedVerified(input: { merchantId: string; railId: string; kind: string; ref: string; connection?: Sql }): Promise<PayoutDestination>;
  /** Active verified destination, promoting a pending change whose hold has passed. */
  require(input: { merchantId: string; railId: string; connection?: Sql }): Promise<PayoutDestination>;
  read(input: { merchantId: string; railId: string; connection?: Sql }): Promise<DestinationState | null>;
  transaction(
    merchantId: string,
    railId: string,
    fn: (row: DestinationState | null, write: DestinationWriter) => Promise<void>,
  ): Promise<void>;
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
    return { kind: row.pending.kind, ref: row.pending.ref, verified: true, pending: null };
  };
  return {
    async persist(input) {
      const dest = assertPersistableDestination(input.railId, input);
      rows.set(key(input.merchantId, input.railId), { ...dest, verified: false, pending: null });
      return dest;
    },
    async seedVerified(input) {
      const dest = assertPersistableDestination(input.railId, input);
      rows.set(key(input.merchantId, input.railId), { ...dest, verified: true, pending: null });
      return dest;
    },
    async require(input) {
      const current = rows.get(key(input.merchantId, input.railId));
      if (!current) throw new PayoutDestinationMissingError(input.merchantId, input.railId);
      const row = promote(current);
      rows.set(key(input.merchantId, input.railId), row);
      if (!row.verified) throw new PayoutDestinationMissingError(input.merchantId, input.railId);
      return { kind: row.kind, ref: row.ref };
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
        async insertVerified(input) {
          next = { kind: input.kind, ref: input.ref, verified: true, pending: null };
        },
        async verifyExisting(input) {
          next = { kind: input.kind, ref: input.ref, verified: true, pending: null };
        },
        async stagePending(input) {
          if (!next?.verified) throw new PayoutDestinationMissingError(merchantId, railId);
          next = { ...next, pending: input };
        },
      };
      await fn(current, write);
      if (next) rows.set(id, next);
    },
  };
}

type DestinationSqlRow = {
  kind: string;
  ref: string;
  verified: boolean;
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
    return { kind: pending.kind, ref: pending.ref, verified: true, pending: null };
  }
  return { kind: row.kind, ref: row.ref, verified: row.verified, pending };
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
                    pending_kind = NULL,
                    pending_ref = NULL,
                    pending_activates_at = NULL,
                    updated_at = now()
    `;
    return dest;
  }

  async require(input: { merchantId: string; railId: string; connection?: Sql }): Promise<PayoutDestination> {
    const row = await this.promote(input.merchantId, input.railId, input.connection);
    if (!row?.verified) throw new PayoutDestinationMissingError(input.merchantId, input.railId);
    return { kind: row.kind, ref: row.ref };
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
        SELECT kind, ref, verified, pending_kind, pending_ref, pending_activates_at
          FROM pay.merchant_payout_destinations
         WHERE merchant_id = ${merchantId} AND rail_id = ${railId}
         FOR UPDATE
      `;
      const now = this.clock();
      if (locked[0]?.verified && locked[0].pending_activates_at && locked[0].pending_activates_at.getTime() <= now.getTime()) {
        await this.applyPromotion(tx, merchantId, railId, now);
      }
      const fresh = await tx<DestinationSqlRow[]>`
        SELECT kind, ref, verified, pending_kind, pending_ref, pending_activates_at
          FROM pay.merchant_payout_destinations
         WHERE merchant_id = ${merchantId} AND rail_id = ${railId}
         FOR UPDATE
      `;
      const row = fresh[0] ? toState(fresh[0], now) : null;
      const write: DestinationWriter = {
        async insertVerified(input) {
          await tx`
            INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified, verified_at)
            VALUES (${merchantId}, ${railId}, ${input.kind}, ${input.ref}, true, ${input.verifiedAt})
          `;
        },
        async verifyExisting(input) {
          const updated = await tx`
            UPDATE pay.merchant_payout_destinations
               SET kind = ${input.kind},
                   ref = ${input.ref},
                   verified = true,
                   verified_at = ${input.verifiedAt},
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

  private async promote(merchantId: string, railId: string, connection?: Sql): Promise<DestinationState | null> {
    const sql = connection ?? this.sql;
    const now = this.clock();
    await this.applyPromotion(sql, merchantId, railId, now);
    const rows = await sql<DestinationSqlRow[]>`
      SELECT kind, ref, verified, pending_kind, pending_ref, pending_activates_at
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
             updated_at = now()
       WHERE merchant_id = ${merchantId}
         AND rail_id = ${railId}
         AND verified = true
         AND pending_activates_at IS NOT NULL
         AND pending_activates_at <= ${now}
    `;
  }
}
