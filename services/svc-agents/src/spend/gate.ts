import type { Sql } from 'postgres';
import type { Amount } from '@intafaced/ledger-client';

/** A period the user named. There is no default. */
export type SpendPeriod = 'day' | 'week' | 'month';

/** Wire view. Amounts are canonical decimal strings, never numbers. */
export interface SpendLimitView {
  readonly assetId: string;
  readonly perCall: string;
  readonly perSession: string;
  readonly perPeriod: string;
  readonly period: SpendPeriod;
}

export interface SpendReservationView {
  readonly reservationKey: string;
  readonly sessionId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly committedAmount: string | null;
  readonly status: 'held' | 'committed' | 'released';
  readonly replayed: boolean;
}

/**
 * What a run calls around the provider.
 *
 * `reserve` holds the worst case before the call. `commitIn` records the real
 * cost on the caller's transaction. `release` drops a hold that never ran.
 */
export interface SpendGate {
  reserve(input: {
    userId: string;
    sessionId: string;
    reservationKey: string;
    assetId: string;
    amount: string;
    now?: Date;
    /** The agent's stored cap per session: what applies when the person set no limits of their own. */
    agentCap?: string | null;
    /**
     * The person's available balance in this asset, read under the reservation's lock. When given, a hold whose
     * amount the balance cannot cover after what is already owed and held refuses `agents.funds_insufficient`.
     */
    funds?: () => Promise<Amount | null>;
    /** The owner's overage grace: unpaid usage in sealed windows up to this much does not count against the balance. */
    overageGrace?: Amount | null;
    /** True only from the team run route, after membership and role were read (`ThinkInput.teamRun`). */
    teamRun?: boolean;
  }): Promise<SpendReservationView>;
  commitIn(tx: Sql, input: { userId: string; reservationKey: string; amount: string }): Promise<SpendReservationView>;
  release(input: { userId: string; reservationKey: string }): Promise<SpendReservationView>;
}
