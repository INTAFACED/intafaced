import { z } from 'zod';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-p2p's records share, moved from the service so the records and every caller read one copy. */

/**
 * ONE PIECE OF EVIDENCE, ON THE WIRE.
 *
 * `item` is `z.unknown()` because it is whatever the party submitted and this
 * service has no business asserting a shape for a screenshot reference or a
 * bank narrative. What it does assert is the envelope: who, when, and in what
 * order — the part a moderator has to be able to trust.
 */
export const evidenceOutput = z.object({
  seq: z.number().int(),
  submittedBy: z.string().nullable(),
  submittedAt: z.string().nullable(),
  item: jsonValueSchema,
});

/**
 * A DISPUTE, ON THE WIRE — the same shape for `.get` and `.list`.
 *
 * `evidence` was the missing field. It was accepted by `disputes.open`, stored
 * in `p2p_disputes.evidence`, carried on `DisputeRecord`, and then never
 * serialised by anything: write-only, so a moderator could not read what they
 * were ruling on. It is here on both reads now.
 */
export const disputeOutput = z.object({
  id: z.string().guid(),
  tradeId: z.string().guid(),
  openedBy: z.string(),
  /**
   * How the dispute was opened. `timeout` means the fiat_sent clock filed it;
   * `openedBy` is then the party of interest (buyer), not a claim they pressed
   * "open dispute". Same honesty class as evidence going write-only.
   */
  openedVia: z.enum(['party', 'timeout']),
  reason: z.string(),
  /** Null only on disputes opened before chat threads were persisted. */
  chatThreadId: z.string().guid().nullable(),
  status: z.enum(['open', 'resolved']),
  moderatorId: z.string().nullable(),
  resolution: z.enum(['release', 'refund']).nullable(),
  /**
   * Moderator notes on the ruling. Accepted by `disputes.resolve`, stored, and
   * previously never serialised — the same write-only trap evidence had.
   * Reviewable afterwards is half of ADR D-S-08's "recorded and reviewable".
   */
  resolutionNotes: z.string().nullable(),
  deadlineAt: z.string(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  evidence: z.array(evidenceOutput),
  /** True when the SLA has passed. The queue's whole reason to exist. */
  overdue: z.boolean(),
  escalatedAt: z.string().nullable(),
  escalations: z.number().int(),
  escalatedBy: z.string().nullable(),
  escalationReason: z.string().nullable(),
  fourEyes: z.boolean().nullable(),
  /** Null until a moderator has actually been served this row. */
  lastSeenByModeratorAt: z.string().nullable(),
});

export const MAX_EVIDENCE_PER_CALL = 10;
