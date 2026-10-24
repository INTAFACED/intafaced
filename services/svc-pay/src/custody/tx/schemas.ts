import { z } from 'zod';
import { WITHDRAWAL_STATUSES } from '../../withdrawals/status.js';

/**
 * Wire shapes for `founderAdmin.custody.tx.*`, `.reasons.*`, `.lifecycle.*` and `.confirmation.*` (W-custody-ops-11).
 * Every input object is `.strict()`. Amounts are decimal strings. A timeout, a default count or a limit is never
 * defaulted: blank stays blank.
 */
const id = z.string().guid();
const networkId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const reason = z.string().trim().min(1).max(500);

/** The custody lifecycle (wallet-custody-ops-054). `FAILED` and `NEEDS_REVIEW` are added so no stored row has no name. */
export const CUSTODY_TX_STATES = [
  'SUBMITTED',
  'PENDING_AML_SCREENING',
  'PENDING_AUTHORIZATION',
  'QUEUED',
  'PENDING_SIGNATURE',
  'SIGNED',
  'BROADCASTING',
  'CONFIRMING',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
  'BLOCKED',
  'FAILED',
  'NEEDS_REVIEW',
] as const;
export type CustodyTxState = (typeof CUSTODY_TX_STATES)[number];

export const txListInputSchema = z
  .object({
    status: z.enum(WITHDRAWAL_STATUSES).optional(),
    assetId: z.string().min(1).max(64).optional(),
    userId: z.string().min(1).max(128).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(200),
    after: z.string().min(1).max(400).optional(),
  })
  .strict();
export type TxListInput = z.infer<typeof txListInputSchema>;

export const txIdInputSchema = z.object({ withdrawalId: id }).strict();
export const txNoteInputSchema = z.object({ withdrawalId: id, note: z.string().trim().min(1).max(2000) }).strict();

export const reasonViewSchema = z.object({
  code: z.string(),
  /** False for a code the catalog does not explain: it is shown raw, never dressed up. */
  known: z.boolean(),
  customer: z.string(),
  support: z.string(),
});

const blockSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_broadcast') }),
  /** A broadcast hash exists but no chain reader is connected here. */
  z.object({ state: z.literal('unwired'), txHash: z.string(), blocker: z.literal('rail.crypto') }),
  z.object({ state: z.literal('unknown_to_chain'), txHash: z.string() }),
  z.object({
    state: z.literal('in_block'),
    txHash: z.string(),
    blockHeight: z.number().int(),
    blockHash: z.string(),
    confirmations: z.number().int(),
  }),
]);

export const txNoteViewSchema = z.object({
  seq: z.number().int(),
  note: z.string(),
  author: z.string(),
  at: z.string().datetime({ offset: true }),
});

export const txItemSchema = z.object({
  withdrawalId: id,
  userId: z.string(),
  assetId: z.string(),
  amount: z.string(),
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  railRef: z.string().nullable(),
  status: z.enum(WITHDRAWAL_STATUSES),
  state: z.enum(CUSTODY_TX_STATES),
  reason: reasonViewSchema.nullable(),
  /** Set when a travel-rule outcome blocks the transfer: the rule version that applied and who decided. */
  blockedBy: z
    .object({ source: z.literal('travel_rule'), status: z.string(), ruleSeq: z.number().int(), decidedBy: z.string() })
    .nullable(),
  /** The owner's timeout for the current state, or null when none is set. */
  timeout: z.object({ seconds: z.number().int(), overdue: z.boolean() }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type TxItem = z.infer<typeof txItemSchema>;

export const txListViewSchema = z.object({ items: z.array(txItemSchema), next: z.string().nullable() });
export const txDetailSchema = txItemSchema.extend({ block: blockSchema, notes: z.array(txNoteViewSchema) });
export type TxDetail = z.infer<typeof txDetailSchema>;

export const timelineEntrySchema = z.object({
  at: z.string().datetime({ offset: true }),
  kind: z.enum(['created', 'travel_rule', 'return', 'note', 'current']),
  detail: z.string(),
  actor: z.string().nullable(),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const timeoutSetInputSchema = z
  .object({ state: z.enum(CUSTODY_TX_STATES), seconds: z.number().int().min(1).max(31_536_000), reason })
  .strict();
export const timeoutViewSchema = z.object({
  state: z.enum(CUSTODY_TX_STATES),
  /** Null while the owner has set none. */
  seconds: z.number().int().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string().datetime({ offset: true }).nullable(),
});

export const confirmationGetInputSchema = z.object({ networkId, withdrawalId: id.optional() }).strict();
export const confirmationViewSchema = z.object({
  networkId: z.string(),
  /** The network registry's count. Null while the registry has none: a customer credit then refuses. */
  networkDefault: z.number().int().nullable(),
  /** The count custody uses: an approved, unexpired override, else the default. Null when neither exists. */
  effective: z.number().int().nullable(),
  source: z.enum(['default', 'network_override', 'transaction_override', 'unset']),
  overrideId: id.nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});

export const confirmationRequestInputSchema = z
  .object({
    networkId,
    withdrawalId: id.optional(),
    confirmations: z.number().int().min(0).max(10_000),
    reason,
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export const confirmationApproveInputSchema = z.object({ requestId: id }).strict();
export const confirmationListInputSchema = z.object({ networkId, limit: z.number().int().min(1).max(200) }).strict();
export const confirmationRequestViewSchema = z.object({
  id,
  scope: z.enum(['network', 'transaction']),
  networkId: z.string(),
  withdrawalId: id.nullable(),
  confirmations: z.number().int(),
  defaultAtRequest: z.number().int(),
  reason: z.string(),
  requestedBy: z.string(),
  requestedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  approvers: z.array(z.string()),
  /** Approved by someone other than the requester, and not expired. */
  effective: z.boolean(),
});
export type ConfirmationRequestView = z.infer<typeof confirmationRequestViewSchema>;
