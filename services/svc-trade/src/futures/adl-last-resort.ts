/**
 * ADL last resort (D26-P1-T1g / DIRECTION:34).
 *
 * After partial liquidation and insurance cover fail, ADL may reduce opposing
 * profitable positions — but never silently, and never with invented parameters.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REFUSE-CLOSED OWNER GATE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Ranking thresholds and reduce magnitudes are D5 / owner law
 * (`docs/BUILD-STOP-TRADE-2026-08-08.md`). This module accepts an explicit
 * {@link AdlOwnerPolicy} or refuses. There is no default `maxReduceBps`, no
 * invented ranking score, and no silent reduce when policy is absent.
 *
 * When policy IS supplied (owner-gated or test harness):
 *   1. Emit an observable disclosure event for each candidate BEFORE reduce
 *   2. Skip candidates who never ack'd in-product disclosure
 *   3. Cap reduce size by owner `maxReduceBps` only
 *   4. Call the reducer — never hold balances here (Doctrine §0.6)
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { ADL_DISCLOSURE_VERSION, type AdlDisclosureStore } from './adl-disclosure.js';

export const ADL_UNCONFIGURED = 'trade.adl_unconfigured' as const;
export const ADL_NO_ELIGIBLE_CANDIDATE = 'trade.adl_no_eligible_candidate' as const;
export const ADL_DISCLOSURE_BEFORE_ACTION = 'trade.adl_disclosure_before_action' as const;

/**
 * Owner-supplied ADL parameters. Absent → refuse. Present fields must be
 * positive integers the owner chose — this file does not invent defaults.
 */
export interface AdlOwnerPolicy {
  /**
   * Maximum fraction of a candidate position that one ADL action may reduce,
   * in basis points (10_000 = 100%). Owner number; no code default.
   */
  readonly maxReduceBps: number;
}

export interface AdlCandidate {
  readonly positionId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: 'long' | 'short';
  readonly size: Amount;
}

export interface AdlBankruptPosition {
  readonly positionId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: 'long' | 'short';
  /** Shortfall the insurance fund could not cover (quote units). Diagnostic. */
  readonly uncoveredShortfall: Amount;
  /** Size still open. When set, no single reduce is sized past it. */
  readonly size?: Amount;
}

/** Observable record that disclosure happened BEFORE any size change. */
export interface AdlActionDisclosureEvent {
  readonly eventId: string;
  readonly at: Date;
  readonly version: string;
  readonly bankruptPositionId: string;
  readonly candidatePositionId: string;
  readonly candidateUserId: string;
  readonly sizeToReduce: string;
  /** Always true on this type — post-action writes are refused. */
  readonly beforeAction: true;
}

export interface AdlDisclosureEventStore {
  record(event: AdlActionDisclosureEvent): Promise<void>;
  listForUser(userId: string, limit: number): Promise<readonly AdlActionDisclosureEvent[]>;
  listForBankrupt(bankruptPositionId: string): Promise<readonly AdlActionDisclosureEvent[]>;
}

export interface AdlReducePort {
  /**
   * Reduce `positionId` (the candidate) by up to `sizeClosed` against the bankrupt
   * position. A reducer that pairs both sides (`adl-pairing.ts`) answers with the
   * size it actually closed; 0 means it found the pair no longer allowed.
   */
  reduce(input: {
    positionId: string;
    bankruptPositionId: string;
    sizeClosed: Amount;
    reason: typeof ADL_DISCLOSURE_BEFORE_ACTION;
    disclosureEventId: string;
  }): Promise<{ sizeClosed: Amount } | void>;
}

export type AdlLastResortOutcome =
  | {
      readonly action: 'refused';
      readonly code: typeof ADL_UNCONFIGURED;
      readonly reason: string;
    }
  | {
      readonly action: 'refused';
      readonly code: typeof ADL_NO_ELIGIBLE_CANDIDATE;
      readonly reason: string;
      readonly disclosuresEmitted: number;
    }
  | {
      readonly action: 'reduced';
      readonly code: typeof ADL_DISCLOSURE_BEFORE_ACTION;
      readonly event: AdlActionDisclosureEvent;
      readonly sizeReduced: Amount;
      readonly candidatePositionId: string;
    };

export interface AdlLastResortInput {
  readonly policy: AdlOwnerPolicy | null;
  readonly bankrupt: AdlBankruptPosition;
  /**
   * Opposing-side candidates in owner-chosen order. This module does not rank —
   * inventing PnL×leverage scores would be D5 product law.
   */
  readonly candidates: readonly AdlCandidate[];
  readonly disclosureAcks: AdlDisclosureStore;
  readonly events: AdlDisclosureEventStore;
  readonly reducer: AdlReducePort;
  readonly at: Date;
  readonly newEventId: () => string;
}

function assertPolicy(policy: AdlOwnerPolicy | null): policy is AdlOwnerPolicy {
  return policy != null && Number.isInteger(policy.maxReduceBps) && policy.maxReduceBps > 0 && policy.maxReduceBps <= 10_000;
}

/**
 * Size to reduce under owner maxReduceBps. Integer bps arithmetic on Amount —
 * never float.
 */
export function sizeUnderAdlCap(size: Amount, maxReduceBps: number): Amount {
  if (size <= 0n || maxReduceBps <= 0) return 0n;
  return (size * BigInt(maxReduceBps)) / 10_000n;
}

/**
 * Last-resort ADL: refuse when unconfigured; otherwise disclose-then-reduce.
 *
 * Order is the safety property: event store write completes before reducer runs.
 */
export async function runAdlLastResort(input: AdlLastResortInput): Promise<AdlLastResortOutcome> {
  if (!assertPolicy(input.policy)) {
    return {
      action: 'refused',
      code: ADL_UNCONFIGURED,
      reason:
        'ADL last resort refused — owner policy unset or invalid (maxReduceBps must be a positive integer ≤ 10000). ' +
        'D5 thresholds/ranking stay owner law; this path invents none and will not silently deleverage.',
    };
  }

  const policy = input.policy;
  const opposite: 'long' | 'short' = input.bankrupt.side === 'long' ? 'short' : 'long';
  let disclosuresEmitted = 0;

  for (const candidate of input.candidates) {
    if (candidate.marketId !== input.bankrupt.marketId) continue;
    if (candidate.side !== opposite) continue;
    if (candidate.userId === input.bankrupt.userId) continue;

    const ack = await input.disclosureAcks.getAck(candidate.userId, ADL_DISCLOSURE_VERSION);
    if (!ack) {
      // Never ADL a user who never saw the disclosure — DIRECTION:34.
      continue;
    }

    let sizeToReduce = sizeUnderAdlCap(candidate.size, policy.maxReduceBps);
    if (input.bankrupt.size !== undefined && sizeToReduce > input.bankrupt.size) sizeToReduce = input.bankrupt.size;
    if (sizeToReduce <= 0n) continue;

    const event: AdlActionDisclosureEvent = {
      eventId: input.newEventId(),
      at: input.at,
      version: ADL_DISCLOSURE_VERSION,
      bankruptPositionId: input.bankrupt.positionId,
      candidatePositionId: candidate.positionId,
      candidateUserId: candidate.userId,
      sizeToReduce: formatAmount(sizeToReduce),
      beforeAction: true,
    };

    // DISCLOSURE BEFORE ACTION — write is awaited; reducer must not run first.
    await input.events.record(event);
    disclosuresEmitted += 1;

    const reduced = await input.reducer.reduce({
      positionId: candidate.positionId,
      bankruptPositionId: input.bankrupt.positionId,
      sizeClosed: sizeToReduce,
      reason: ADL_DISCLOSURE_BEFORE_ACTION,
      disclosureEventId: event.eventId,
    });
    const sizeReduced = reduced ? reduced.sizeClosed : sizeToReduce;
    if (sizeReduced <= 0n) continue;

    return {
      action: 'reduced',
      code: ADL_DISCLOSURE_BEFORE_ACTION,
      event,
      sizeReduced,
      candidatePositionId: candidate.positionId,
    };
  }

  return {
    action: 'refused',
    code: ADL_NO_ELIGIBLE_CANDIDATE,
    reason:
      'ADL last resort found no eligible opposing candidate with a prior disclosure ack ' +
      '(and owner policy present). Unacked positions are never silently deleveraged.',
    disclosuresEmitted,
  };
}

/** In-memory event log for hermetic tests / public-door proofs. */
export function memoryAdlDisclosureEventStore(): AdlDisclosureEventStore {
  const rows: AdlActionDisclosureEvent[] = [];
  return {
    async record(event) {
      if (!event.beforeAction) {
        throw new Error('ADL disclosure events must be beforeAction:true — silent post-action writes are forbidden');
      }
      rows.push(event);
    },
    async listForUser(userId, limit) {
      return rows
        .filter((r) => r.candidateUserId === userId)
        .slice()
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, limit);
    },
    async listForBankrupt(bankruptPositionId) {
      return rows.filter((r) => r.bankruptPositionId === bankruptPositionId);
    },
  };
}

export interface AdlActionDisclosureWire {
  eventId: string;
  at: string;
  version: string;
  bankruptPositionId: string;
  candidatePositionId: string;
  candidateUserId: string;
  sizeToReduce: string;
  beforeAction: true;
}

export function presentAdlActionDisclosureWire(event: AdlActionDisclosureEvent): AdlActionDisclosureWire {
  return {
    eventId: event.eventId,
    at: event.at.toISOString(),
    version: event.version,
    bankruptPositionId: event.bankruptPositionId,
    candidatePositionId: event.candidatePositionId,
    candidateUserId: event.candidateUserId,
    sizeToReduce: event.sizeToReduce,
    beforeAction: true,
  };
}

/** Durable disclosure-before-action log. CHECK enforces before_action = true. */
export function sqlAdlDisclosureEventStore(sql: Sql): AdlDisclosureEventStore {
  return {
    async record(event) {
      if (!event.beforeAction) {
        throw new Error('ADL disclosure events must be beforeAction:true — silent post-action writes are forbidden');
      }
      await sql`
        INSERT INTO trade.adl_action_disclosures (
          event_id, at, version, bankrupt_position_id, candidate_position_id,
          candidate_user_id, size_to_reduce, before_action
        ) VALUES (
          ${event.eventId},
          ${event.at},
          ${event.version},
          ${event.bankruptPositionId},
          ${event.candidatePositionId},
          ${event.candidateUserId},
          ${event.sizeToReduce}::numeric,
          true
        )
      `;
    },
    async listForUser(userId, limit) {
      const rows = await sql<
        {
          event_id: string;
          at: Date;
          version: string;
          bankrupt_position_id: string;
          candidate_position_id: string;
          candidate_user_id: string;
          size_to_reduce: string;
          before_action: boolean;
        }[]
      >`
        SELECT event_id, at, version, bankrupt_position_id, candidate_position_id,
               candidate_user_id, size_to_reduce::text AS size_to_reduce, before_action
          FROM trade.adl_action_disclosures
         WHERE candidate_user_id = ${userId}
         ORDER BY at DESC
         LIMIT ${limit}
      `;
      return rows.map(rowFromSql);
    },
    async listForBankrupt(bankruptPositionId) {
      const rows = await sql<
        {
          event_id: string;
          at: Date;
          version: string;
          bankrupt_position_id: string;
          candidate_position_id: string;
          candidate_user_id: string;
          size_to_reduce: string;
          before_action: boolean;
        }[]
      >`
        SELECT event_id, at, version, bankrupt_position_id, candidate_position_id,
               candidate_user_id, size_to_reduce::text AS size_to_reduce, before_action
          FROM trade.adl_action_disclosures
         WHERE bankrupt_position_id = ${bankruptPositionId}
         ORDER BY at DESC
      `;
      return rows.map(rowFromSql);
    },
  };
}

function rowFromSql(row: {
  event_id: string;
  at: Date;
  version: string;
  bankrupt_position_id: string;
  candidate_position_id: string;
  candidate_user_id: string;
  size_to_reduce: string;
  before_action: boolean;
}): AdlActionDisclosureEvent {
  // Re-canonicalise via ledger parse/format so wire decimals stay Amount-honest.
  const size = formatAmount(parseAmount(row.size_to_reduce));
  return {
    eventId: row.event_id,
    at: row.at,
    version: row.version,
    bankruptPositionId: row.bankrupt_position_id,
    candidatePositionId: row.candidate_position_id,
    candidateUserId: row.candidate_user_id,
    sizeToReduce: size,
    beforeAction: true,
  };
}
