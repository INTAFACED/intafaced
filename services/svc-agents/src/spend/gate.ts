import type { Sql } from 'postgres';

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
  }): Promise<SpendReservationView>;
  commitIn(tx: Sql, input: { userId: string; reservationKey: string; amount: string }): Promise<SpendReservationView>;
  release(input: { userId: string; reservationKey: string }): Promise<SpendReservationView>;
}
