import { z } from 'zod';

/**
 * PP-disputes-safety-01 (contracts first): a dispute case, opened with a reason, routed, and checked for eligibility.
 *
 * The case is keyed server-side `dispute:<userId>:<activityId>` (PD-1): the client no longer mints the case id, so the
 * same open sent twice is the same case. No money moves in this slice. The reason table is owner-published legal copy
 * (owner decision): a missing table refuses with its blocker, and an unknown code refuses.
 */
export const PAY_DISPUTE_CASE_STATES = [
  'submitted',
  'info_requested',
  'offered',
  'accepted_offer',
  'escalated',
  'under_review',
  'resolved_buyer',
  'resolved_seller',
  'appealed',
  'cancelled',
  'auto_closed',
] as const;
export const payDisputeCaseStateSchema = z.enum(PAY_DISPUTE_CASE_STATES);
export type PayDisputeCaseState = z.infer<typeof payDisputeCaseStateSchema>;

/**
 * PD-3 transitions. A state not listed as a source is terminal. No path skips review: `submitted` can never go
 * straight to a resolution.
 */
export const PAY_DISPUTE_TRANSITIONS: Readonly<Record<PayDisputeCaseState, readonly PayDisputeCaseState[]>> = {
  submitted: ['info_requested', 'offered', 'escalated', 'under_review', 'cancelled', 'auto_closed'],
  info_requested: ['submitted', 'cancelled', 'auto_closed'],
  offered: ['accepted_offer', 'escalated', 'cancelled', 'auto_closed'],
  accepted_offer: [],
  escalated: ['under_review', 'cancelled'],
  under_review: ['info_requested', 'resolved_buyer', 'resolved_seller'],
  resolved_buyer: [],
  resolved_seller: ['appealed'],
  appealed: ['under_review'],
  cancelled: [],
  auto_closed: [],
};

export function canTransitionDispute(from: PayDisputeCaseState, to: PayDisputeCaseState): boolean {
  return PAY_DISPUTE_TRANSITIONS[from].includes(to);
}

export const payDisputeReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

export const payDisputeOpenInputSchema = z
  .object({
    activityId: z.string().min(1).max(512),
    reasonCode: payDisputeReasonCodeSchema,
    statement: z.string().min(1).max(2000),
    linkedActivityIds: z.array(z.string().min(1).max(512)).max(10).default([]),
  })
  .strict();
export type PayDisputeOpenInput = z.infer<typeof payDisputeOpenInputSchema>;

/** Either a case here, or the line is routed to its card issuer and no case is created. */
export const payDisputeOpenResultSchema = z.discriminatedUnion('routedTo', [
  z
    .object({
      routedTo: z.literal('case'),
      caseId: z.string().uuid(),
      status: payDisputeCaseStateSchema,
      reasonCode: payDisputeReasonCodeSchema,
      createdAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z.object({ routedTo: z.literal('card_issuer'), activityId: z.string() }).strict(),
]);
export type PayDisputeOpenResult = z.infer<typeof payDisputeOpenResultSchema>;

export const PAY_DISPUTE_INELIGIBLE_REASONS = ['pending', 'already_refunded'] as const;

export const PAY_DISPUTE_CODES = [
  'pay.dispute_ineligible',
  'pay.dispute_reasons_unset',
  'pay.dispute_reason_unknown',
  'pay.dispute_transition_refused',
  'pay.dispute_conflict',
  /** A card or refund fact for the line is not known yet (fail closed). */
  'pay.dispute_line_facts_unset',
  /** The dispute service is not wired in this deployment. */
  'pay.dispute_unwired',
] as const;
export type PayDisputeCode = (typeof PAY_DISPUTE_CODES)[number];
