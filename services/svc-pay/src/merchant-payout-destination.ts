import type { Sql } from 'postgres';
import { maskDestination, safeDestinationLabel } from './control/mask-destination.js';
import { decodeCursor, encodeCursor, requireLimit } from './merchant-ops/pagination.js';
import { assertPayoutDestinationKind, DestinationKindError } from './payout-destination.js';

/**
 * Persisted merchant payout destination — the ref a later `payoutSettlement`
 * must already have BEFORE `withdrawHold`.
 *
 * Shape + kind go through `assertPayoutDestinationKind` (IBAN / IFSC / EVM).
 * This file does not live-wire `bank-payout` (that adapter stays `mode: absent`)
 * and does not invent a PSP.
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

export type MerchantPayoutDestinations = {
  persist(input: { merchantId: string; railId: string; kind: string; ref: string; connection?: Sql }): Promise<PayoutDestination>;
  require(input: { merchantId: string; railId: string; connection?: Sql }): Promise<PayoutDestination>;
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

/**
 * Router-test default: assert on persist, never invent a stored ref.
 * A later payout without a dest refuses closed.
 */
export function assertOnlyPayoutDestinations(): MerchantPayoutDestinations {
  return {
    async persist(input) {
      return assertPersistableDestination(input.railId, input);
    },
    async require(input) {
      throw new PayoutDestinationMissingError(input.merchantId, input.railId);
    },
  };
}

/** In-memory store for tests. Persist stores; require refuses if none. */
export function memoryPayoutDestinations(): MerchantPayoutDestinations {
  const rows = new Map<string, PayoutDestination>();
  const key = (merchantId: string, railId: string) => `${merchantId}:${railId}`;
  return {
    async persist(input) {
      const dest = assertPersistableDestination(input.railId, input);
      rows.set(key(input.merchantId, input.railId), dest);
      return dest;
    },
    async require(input) {
      const dest = rows.get(key(input.merchantId, input.railId));
      if (!dest) throw new PayoutDestinationMissingError(input.merchantId, input.railId);
      return dest;
    },
  };
}

export class MerchantPayoutDestinationStore implements MerchantPayoutDestinations {
  constructor(private readonly sql: Sql) {}

  async persist(input: { merchantId: string; railId: string; kind: string; ref: string; connection?: Sql }): Promise<PayoutDestination> {
    const dest = assertPersistableDestination(input.railId, input);
    await (input.connection ?? this.sql)`
      INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref)
      VALUES (${input.merchantId}, ${input.railId}, ${dest.kind}, ${dest.ref})
      ON CONFLICT (merchant_id, rail_id)
      DO UPDATE SET kind = excluded.kind, ref = excluded.ref, updated_at = now()
    `;
    return dest;
  }

  async require(input: { merchantId: string; railId: string; connection?: Sql }): Promise<PayoutDestination> {
    const rows = await (input.connection ?? this.sql)<Array<{ kind: string; ref: string }>>`
      SELECT kind, ref FROM pay.merchant_payout_destinations
       WHERE merchant_id = ${input.merchantId} AND rail_id = ${input.railId}
    `;
    const row = rows[0];
    if (!row) throw new PayoutDestinationMissingError(input.merchantId, input.railId);
    return { kind: row.kind, ref: row.ref };
  }

  /**
   * Founder and merchant lists see a mask. The stored ref stays in this method
   * and is not part of the return value. The full value is the audited
   * approval-destination read, not this list.
   */
  async listMasked(
    merchantId: string,
    input: { limit?: number; cursor?: string },
  ): Promise<{
    items: Array<{ railId: string; kind: string; destinationMasked: string; updatedAt: string }>;
    nextCursor: string | null;
  }> {
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const rows = await this.sql<Array<{ rail_id: string; kind: string; ref: string; updated_at: Date; cursor_ts: string }>>`
      SELECT rail_id, kind, ref, updated_at,
             to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM pay.merchant_payout_destinations
       WHERE merchant_id = ${merchantId}
         ${after ? this.sql`AND (updated_at, rail_id) < ((${after.ts}::text)::timestamptz, ${after.key})` : this.sql``}
       ORDER BY updated_at DESC, rail_id DESC
       LIMIT ${limit + 1}`;
    const kept = rows.slice(0, limit);
    const last = kept[kept.length - 1];
    return {
      items: kept.map((row) => ({
        railId: row.rail_id,
        kind: safeDestinationLabel(row.kind, row.ref),
        destinationMasked: maskDestination(row.kind, row.ref),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.rail_id) : null,
    };
  }
}
