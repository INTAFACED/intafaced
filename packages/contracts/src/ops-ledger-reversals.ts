import { z } from 'zod';

/**
 * Wire types for an operator's corrective reversal of a posted ledger transaction (OPS-ledger-desk-02, journey
 * J-ops-console-05 steps 1-3).
 *
 * svc-ops keeps the request: one intent row per reversal asked for, written before anything else happens, with its own
 * sequence number, the original transaction, the ordinal its ledger key is built from, the reason and the case reference.
 * Nothing posts until a different person approves exactly that request at identity (governed action type
 * `ops.ledger.reverse`, bound to the request number, the original, the reason and the case reference) and the requester
 * runs it. svc-ops then asks svc-ledger's `operatorReverse` door once; the ledger builds the compensating transaction
 * itself from the stored original under `ops:reversal:<originalTxId>:<ordinal>`. svc-ops never assembles an entry.
 *
 * Browser-safe: zod only.
 */

export const OPS_LEDGER_REVERSE_ACTION = 'ops.ledger.reverse' as const;
export const OPS_LEDGER_REVERSE_TARGET_SERVICE = 'svc-ops' as const;

/** svc-ops has no durable storage, so no reversal can be asked for or read. */
export const OPS_REVERSAL_STORAGE_UNCONFIGURED = 'ops.reversal_storage_unconfigured' as const;
/** svc-ops has no ledger URL or credential, so no reversal can be asked for or run. Nothing is written. */
export const OPS_REVERSAL_LEDGER_UNCONFIGURED = 'ops.reversal_ledger_unconfigured' as const;
/** The original already has a posted reversal: it is reversed once. The refusal names the first reversal. */
export const OPS_REVERSAL_ALREADY_REVERSED = 'ops.reversal_already_reversed' as const;
/** No reversal request has that number. */
export const OPS_REVERSAL_NOT_FOUND = 'ops.reversal_not_found' as const;
/** The request was already run with another approval, or has settled. */
export const OPS_REVERSAL_STATE_ILLEGAL = 'ops.reversal_state_illegal' as const;
/** Only the person who asked for the reversal runs it, with the approval a different person gave. */
export const OPS_REVERSAL_REQUESTER_ONLY = 'ops.reversal_requester_only' as const;
/** The approval was given by the person who asked for the reversal. */
export const OPS_REVERSAL_SAME_PERSON = 'action_approval.same_person' as const;

export const OPS_REVERSAL_REASON_MAX = 500;
export const OPS_REVERSAL_CASE_REF_MAX = 128;

/** Approval target for one request: `reversal:<requestNo>`. */
export function opsReversalTargetId(requestNo: string): string {
  return `reversal:${requestNo}`;
}

/** What a reversal approval signs: the request, the original, the reason and the case reference, as stored. */
export function opsReversalApprovalFields(request: {
  readonly requestNo: string;
  readonly originalTxId: string;
  readonly reason: string;
  readonly caseRef: string;
}): Record<string, string> {
  const { requestNo, originalTxId, reason, caseRef } = request;
  return { targetId: opsReversalTargetId(requestNo), originalTxId, reason, caseRef };
}

const iso = z.string().datetime({ offset: true });
const txId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a lowercase transaction id');
const requestNo = z.string().regex(/^[1-9][0-9]{0,18}$/, 'a reversal request number');
/** Written as typed, trimmed at both ends: the approver signs exactly what is stored. */
const reason = z
  .string()
  .max(OPS_REVERSAL_REASON_MAX)
  .regex(/^\S(?:[\s\S]*\S)?$/, 'a reason with no space at either end');
const caseRef = z
  .string()
  .max(OPS_REVERSAL_CASE_REF_MAX)
  .regex(/^\S(?:[\s\S]*\S)?$/, 'a case reference with no space at either end');

export const OPS_REVERSAL_STATES = ['intent', 'posting', 'pending_retry', 'posted', 'refused'] as const;
export type OpsReversalState = (typeof OPS_REVERSAL_STATES)[number];

/**
 * One reversal request as svc-ops stores it. `intent` waits for the approval; `posting` has spent it and is with the ledger;
 * `pending_retry` is a reply that was lost or the posting freeze (the next send is the same key and body); `posted` names the
 * reversing transaction; `refused` holds the ledger's code, and `reversedBy` when the ledger named another reversal.
 */
export const opsLedgerReversalSchema = z.object({
  requestNo,
  originalTxId: txId,
  /** The ordinal of the ledger key, stored with the intent and never changed. */
  ordinal: requestNo,
  reason: z.string(),
  caseRef: z.string(),
  state: z.enum(OPS_REVERSAL_STATES),
  requestedBy: z.string(),
  requestedAt: iso,
  approverId: z.string().nullable(),
  approvedAt: iso.nullable(),
  /** `ops:reversal:<originalTxId>:<ordinal>`. */
  ledgerKey: z.string(),
  reversingTxId: txId.nullable(),
  /** The ledger's typed answer: the refusal when refused, the last failed send while pending_retry; null otherwise. */
  code: z.string().nullable(),
  /** The first reversal the ledger named when it refused this one as already reversed. */
  reversedBy: txId.nullable(),
  /** Sends to the ledger under the key. */
  attempts: z.number().int().min(0),
  lastAttemptAt: iso.nullable(),
  settledAt: iso.nullable(),
});
export type OpsLedgerReversal = z.infer<typeof opsLedgerReversalSchema>;

export const opsReversalRequestInputSchema = z.object({ originalTxId: txId, reason, caseRef });
export type OpsReversalRequestInput = z.infer<typeof opsReversalRequestInputSchema>;

export const opsReversalExecuteInputSchema = z.object({
  requestNo,
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
});
export type OpsReversalExecuteInput = z.infer<typeof opsReversalExecuteInputSchema>;

export const opsReversalGetInputSchema = z.object({ requestNo });

export const opsReversalListInputSchema = z.object({ originalTxId: txId, limit: z.number().int().min(1).max(100) });
export const opsReversalListSchema = z.object({ reversals: z.array(opsLedgerReversalSchema), asOf: iso });
export type OpsReversalList = z.infer<typeof opsReversalListSchema>;
