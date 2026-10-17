import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { maskDestination, safeDestinationLabel } from '../control/mask-destination.js';
import { safeFailure, type MerchantFailure } from '../merchant-failure.js';
import type { PayFail } from './common.js';
import { stableUuid } from './common.js';
import { compareLifecycleEvents, derivePayoutLifecycleStatus, type LifecycleKind, type LifecycleStatus } from './lifecycle-status.js';

/**
 * One payout's timeline. Status is `derivePayoutLifecycleStatus` of these
 * events. When the settlement status column is ahead of the recorded
 * timestamps, one synthetic event `{ at: null, timeKnown: false }` is
 * appended so the derived status is not lower than the column. Rows written
 * before migration 0073 have no `settled_at` / `sent_at` / `failed_at`.
 *
 * Screening is `not_recorded`: W9 does not store a destination verdict.
 * Destinations are masked. Rail references and approval free text stay off
 * the wire. A failure is `safeFailure` of a stored code.
 */

export interface LifecycleEvent {
  id: string;
  at: string | null;
  timeKnown: boolean;
  kind: LifecycleKind;
  approvalId: string | null;
  railId: string | null;
  destinationKind: string | null;
  destinationMasked: string | null;
  failure: MerchantFailure | null;
}

export interface PayoutLifecycle {
  settlementId: string;
  status: 'pending' | 'posted' | 'paid_out' | 'failed';
  screening: 'not_recorded';
  fee: string | null;
  destination: { railId: string; kind: string; destinationMasked: string } | null;
  failure: MerchantFailure | null;
  events: LifecycleEvent[];
}

interface Built {
  at: Date;
  kind: LifecycleKind;
  approvalId: string | null;
  railId: string | null;
  destinationKind: string | null;
  destinationMasked: string | null;
  failure: MerchantFailure | null;
  source: string;
}

function masked(kind: string, ref: string): { kind: string; masked: string } {
  return { kind: safeDestinationLabel(kind, ref), masked: maskDestination(kind, ref) };
}

function iso(date: Date): string {
  return date.toISOString();
}

export async function readPayoutLifecycle(sql: Sql, settlementId: string, fail: PayFail): Promise<PayoutLifecycle> {
  const settlements = await sql<
    Array<{
      id: string;
      merchant_id: string;
      fees: string;
      status: string;
      created_at: Date;
      settled_at: Date | null;
      sent_at: Date | null;
      failed_at: Date | null;
      failure_code: string | null;
    }>
  >`
    SELECT id, merchant_id, fees::text, status::text AS status, created_at, settled_at, sent_at, failed_at, failure_code
      FROM pay.settlements WHERE id = ${settlementId}
  `;
  const settlement = settlements[0];
  if (!settlement) return fail(`Settlement ${settlementId} not found`, 'pay.settlement_not_found');

  const approvals = await sql<
    Array<{
      id: string;
      status: string;
      rail_id: string;
      destination_kind: string;
      destination_ref: string;
      created_at: Date;
      decided_at: Date | null;
    }>
  >`
    SELECT id, status, rail_id, destination_kind, destination_ref, created_at, decided_at
      FROM pay.control_payout_approvals
     WHERE settlement_id = ${settlementId} AND merchant_id = ${settlement.merchant_id}
     ORDER BY seq ASC
  `;

  const outcomes = await sql<
    Array<{
      admission_id: string;
      rail_id: string;
      destination_kind: string;
      destination_ref: string;
      admitted_at: Date;
      outcome_kind: string | null;
      payload: Record<string, unknown> | null;
      occurred_at: Date | null;
    }>
  >`
    SELECT a.id AS admission_id, a.rail_id, a.destination_kind, a.destination_ref, a.admitted_at,
           o.kind AS outcome_kind, o.payload, o.occurred_at
      FROM pay.payout_admissions a
      LEFT JOIN pay.payout_outcomes o ON o.admission_id = a.id
     WHERE a.settlement_id = ${settlementId} AND a.merchant_id = ${settlement.merchant_id}
     ORDER BY a.admitted_at ASC, o.occurred_at ASC NULLS LAST
  `;

  const built: Built[] = [
    {
      at: settlement.created_at,
      kind: 'settlement.opened',
      approvalId: null,
      railId: null,
      destinationKind: null,
      destinationMasked: null,
      failure: null,
      source: 'opened',
    },
  ];
  if (settlement.settled_at) {
    built.push({
      at: settlement.settled_at,
      kind: 'settlement.posted',
      approvalId: null,
      railId: null,
      destinationKind: null,
      destinationMasked: null,
      failure: null,
      source: 'posted',
    });
  }

  for (const row of approvals) {
    const dest = masked(row.destination_kind, row.destination_ref);
    const railId = safeDestinationLabel(row.rail_id, row.destination_ref);
    built.push({
      at: row.created_at,
      kind: 'approval.requested',
      approvalId: row.id,
      railId,
      destinationKind: dest.kind,
      destinationMasked: dest.masked,
      failure: null,
      source: `approval-req-${row.id}`,
    });
    if (row.status !== 'pending') {
      const kind = decisionKind(row.status);
      if (kind) {
        built.push({
          at: row.decided_at ?? row.created_at,
          kind,
          approvalId: row.id,
          railId,
          destinationKind: dest.kind,
          destinationMasked: dest.masked,
          failure: null,
          source: `approval-${row.status}-${row.id}`,
        });
      }
    }
  }

  const seenAdmission = new Set<string>();
  let sawSent = false;
  let sawRefused = false;
  let sawReversed = false;
  for (const row of outcomes) {
    const dest = masked(row.destination_kind, row.destination_ref);
    const railId = safeDestinationLabel(row.rail_id, row.destination_ref);
    if (!seenAdmission.has(row.admission_id)) {
      seenAdmission.add(row.admission_id);
      built.push({
        at: row.admitted_at,
        kind: 'payout.admitted',
        approvalId: null,
        railId,
        destinationKind: dest.kind,
        destinationMasked: dest.masked,
        failure: null,
        source: `admit-${row.admission_id}`,
      });
    }
    if (!row.outcome_kind || !row.occurred_at) continue;
    if (row.outcome_kind === 'rail_accepted') {
      sawSent = true;
      built.push({
        at: row.occurred_at,
        kind: 'rail.sent',
        approvalId: null,
        railId,
        destinationKind: dest.kind,
        destinationMasked: dest.masked,
        failure: null,
        source: `sent-${row.admission_id}`,
      });
    } else if (row.outcome_kind === 'settled') {
      built.push({
        at: row.occurred_at,
        kind: 'rail.confirmed',
        approvalId: null,
        railId,
        destinationKind: dest.kind,
        destinationMasked: dest.masked,
        failure: null,
        source: `confirmed-${row.admission_id}`,
      });
    } else if (row.outcome_kind === 'rail_refused') {
      sawRefused = true;
      const code = typeof row.payload?.failureCode === 'string' ? row.payload.failureCode : null;
      built.push({
        at: row.occurred_at,
        kind: 'rail.refused',
        approvalId: null,
        railId,
        destinationKind: dest.kind,
        destinationMasked: dest.masked,
        failure: safeFailure(code),
        source: `refused-${row.admission_id}`,
      });
    } else if (row.outcome_kind === 'reversed') {
      sawReversed = true;
      built.push({
        at: row.occurred_at,
        kind: 'payout.reversed',
        approvalId: null,
        railId,
        destinationKind: dest.kind,
        destinationMasked: dest.masked,
        failure: null,
        source: `reversed-${row.admission_id}`,
      });
    }
  }

  if (settlement.sent_at && !sawSent) {
    built.push({
      at: settlement.sent_at,
      kind: 'rail.sent',
      approvalId: null,
      railId: null,
      destinationKind: null,
      destinationMasked: null,
      failure: null,
      source: 'sent-column',
    });
  }
  if (settlement.failed_at && settlement.failure_code === 'pay.settlement_released') {
    built.push({
      at: settlement.failed_at,
      kind: 'settlement.released',
      approvalId: null,
      railId: null,
      destinationKind: null,
      destinationMasked: null,
      failure: safeFailure(settlement.failure_code),
      source: 'released',
    });
  } else if (settlement.failed_at && !sawRefused && !sawReversed && settlement.failure_code !== 'pay.settlement_released') {
    built.push({
      at: settlement.failed_at,
      kind: 'rail.refused',
      approvalId: null,
      railId: null,
      destinationKind: null,
      destinationMasked: null,
      failure: safeFailure(settlement.failure_code),
      source: 'failed-column',
    });
  }

  const events: LifecycleEvent[] = built.map((event) => ({
    id: stableUuid(`${settlement.id}:${event.source}`),
    at: iso(event.at),
    timeKnown: true,
    kind: event.kind,
    approvalId: event.approvalId,
    railId: event.railId,
    destinationKind: event.destinationKind,
    destinationMasked: event.destinationMasked,
    failure: event.failure,
  }));
  const column = lifecycleStatus(settlement.status);
  const floor = column ? floorKind(column, settlement.failure_code) : null;
  if (column && floor && STATUS_RANK[derivePayoutLifecycleStatus(events.map((event) => event.kind))] < STATUS_RANK[column]) {
    events.push({
      id: stableUuid(`${settlement.id}:floor-${column}`),
      at: null,
      timeKnown: false,
      kind: floor,
      approvalId: null,
      railId: null,
      destinationKind: null,
      destinationMasked: null,
      failure: column === 'failed' ? safeFailure(settlement.failure_code) : null,
    });
  }
  events.sort(compareLifecycleEvents);

  const status = derivePayoutLifecycleStatus(events.map((event) => event.kind));
  const withDestination = [...events].reverse().find((event) => event.destinationMasked && event.railId && event.destinationKind);
  const failure = status === 'failed' ? ([...events].reverse().find((event) => event.failure)?.failure ?? null) : null;
  let fee: string | null = null;
  try {
    fee = formatAmount(parseAmount(settlement.fees));
  } catch {
    fee = null;
  }

  return {
    settlementId,
    status,
    screening: 'not_recorded',
    fee,
    destination: withDestination
      ? { railId: withDestination.railId!, kind: withDestination.destinationKind!, destinationMasked: withDestination.destinationMasked! }
      : null,
    failure,
    events,
  };
}

const STATUS_RANK: Record<LifecycleStatus, number> = {
  pending: 0,
  posted: 1,
  paid_out: 2,
  failed: 3,
};

function lifecycleStatus(status: string): LifecycleStatus | null {
  if (status === 'pending' || status === 'posted' || status === 'paid_out' || status === 'failed') return status;
  return null;
}

/** The kind that raises derived status to the column when no timestamp records it. */
function floorKind(status: LifecycleStatus, failureCode: string | null): LifecycleKind | null {
  if (status === 'posted') return 'settlement.posted';
  if (status === 'paid_out') return 'rail.confirmed';
  if (status === 'failed') return failureCode === 'pay.settlement_released' ? 'settlement.released' : 'rail.refused';
  return null;
}

function decisionKind(status: string): LifecycleKind | null {
  switch (status) {
    case 'approved':
      return 'approval.approved';
    case 'rejected':
      return 'approval.rejected';
    case 'voided':
      return 'approval.voided';
    case 'expired':
      return 'approval.expired';
    case 'consumed':
      return 'approval.consumed';
    default:
      return null;
  }
}
