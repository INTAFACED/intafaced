import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-bank `global.*` the customer calls: send money abroad from a space, one record per call. A quote locks its rate
 * until its valid-until, and a send names the lock it was confirmed on; a send is posted only through svc-bank's own
 * recipe, under its business key. svc-bank mounts each from here (`personal-pay/router.ts`) and the customer app calls
 * each by its record. The operator doors (`global.ops.*`) are not here.
 */

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
const idString = z.string().min(8).max(128);
const limitField = z.number().int().min(1).max(100).optional();
const accountKind = z.enum(['iban', 'ifsc', 'account_number']);

export const GLOBAL_SEND_STATUSES = [
  'submitted',
  'held',
  'sent',
  'on_the_way',
  'arrived',
  'failed',
  'cancelled',
  'returned',
  'refunded',
] as const;

/** A destination the partner's catalogue publishes. */
export const globalCorridorSchema = z.object({
  country: z.string(),
  currency: z.string(),
  deliveryMethods: z.array(z.string()),
  minAmount: z.string().nullable(),
  maxAmount: z.string().nullable(),
  cutOffTime: z.string().nullable(),
  /** On a SWIFT corridor, who bears the banks' charges as the partner answers it (SHA, OUR, BEN); null when it gave none. */
  swiftCharges: z.enum(['SHA', 'OUR', 'BEN']).nullable(),
  /** The delivery methods a payout partner pays out on; a send on any other is refused before anything is posted. */
  payoutMethods: z.array(z.string()),
});
export type GlobalCorridor = z.output<typeof globalCorridorSchema>;

export const globalRecipientSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  name: z.string(),
  account: z.string(),
  accountKind,
  bic: z.string().nullable(),
  country: z.string(),
  createdAt: z.string(),
});
export type GlobalRecipient = z.output<typeof globalRecipientSchema>;

export const globalValidationSchema = z.object({
  format: z.enum(['valid', 'invalid']),
  formatKind: accountKind.nullable(),
  normalized: z.string().nullable(),
  bicLookup: z.discriminatedUnion('status', [
    z.object({ status: z.literal('not_requested') }),
    z.object({ status: z.literal('invalid'), code: z.literal('bank.global_bic_format_invalid') }),
    z.object({
      status: z.literal('refused'),
      code: z.literal('bank.global_bic_directory_unset'),
      blocker: z.literal('socket.psp-partners'),
    }),
    z.object({ status: z.literal('unmatched') }),
    z.object({ status: z.literal('matched'), bic: z.string(), bankName: z.string() }),
  ]),
});
export type GlobalValidation = z.output<typeof globalValidationSchema>;

export const globalQuoteSchema = z.object({
  /** The rate lock: a send confirmed on it before `validUntil` is paid at exactly these figures. */
  quoteId: z.string().guid(),
  /** The service's clock as the lock was taken: the lock lasts `validUntil - lockedAt`. */
  lockedAt: z.string(),
  rate: amount,
  fee: amount,
  feeAsset: z.string(),
  receiveAmount: amount,
  validUntil: z.string(),
  eta: z.string(),
});
export type GlobalQuote = z.output<typeof globalQuoteSchema>;

export const globalSendSchema = z.object({
  id: z.string(),
  fromSpaceId: z.string(),
  assetId: assetIdSchema,
  amount,
  toCurrency: z.string(),
  recipientId: z.string(),
  country: z.string(),
  deliveryMethod: z.string(),
  status: z.enum(GLOBAL_SEND_STATUSES),
  failureCode: z.string().nullable(),
  failureBlocker: z.string().nullable(),
  providerRef: z.string().nullable(),
  quoteRate: z.string().nullable(),
  quoteFee: z.string().nullable(),
  quoteFeeAsset: z.string().nullable(),
  quoteReceive: z.string().nullable(),
  quoteValidUntil: z.string().nullable(),
  quoteEta: z.string().nullable(),
  quoteId: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  cancelledBy: z.enum(['customer', 'auto']).nullable(),
  returnRef: z.string().nullable(),
  returnedAt: z.string().nullable(),
  refundedAt: z.string().nullable(),
  recallReason: z.string().nullable(),
  recallRequestedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GlobalSend = z.output<typeof globalSendSchema>;

export const GLOBAL_HOLD_STATES = ['requested', 'under_review', 'released', 'cancelled'] as const;
/** A hold on a send as its customer reads it: what review asks for, whether proof is in, and the auto-cancel rule. */
export const globalCustomerHoldSchema = z.object({
  state: z.enum(GLOBAL_HOLD_STATES),
  infoRequest: z.string().nullable(),
  proofUploaded: z.boolean(),
  proofLimits: z.object({ allowedTypes: z.array(z.string()), maxBytes: z.number() }).nullable(),
  autoCancel: z.object({ state: z.enum(['unset', 'published']), hours: z.number().nullable(), at: z.string().nullable() }),
});
export type GlobalHold = z.output<typeof globalCustomerHoldSchema>;

/** The signed receipt of a send that left: its text, SHA-256, signature and ledger transaction id. */
export const globalReceiptSchema = z
  .object({ fileName: z.string(), text: z.string(), ledgerTxId: z.string(), sha256: z.string(), signature: z.string() })
  .strict();
export type GlobalReceipt = z.output<typeof globalReceiptSchema>;

/** Each refusal by its code, with the status svc-bank sends it with (`personal-pay/errors.ts`, the router's `guard`). */
const STATUS = {
  'bank.personal_pay_request_invalid': 'BAD_REQUEST',
  'bank.global_corridors_unset': 'PRECONDITION_FAILED',
  'bank.global_corridors_unusable': 'SERVICE_UNAVAILABLE',
  'bank.global_corridor_unknown': 'PRECONDITION_FAILED',
  'bank.global_amount_outside_corridor': 'PRECONDITION_FAILED',
  'bank.global_payout_unusable': 'SERVICE_UNAVAILABLE',
  'bank.global_payout_unset': 'PRECONDITION_FAILED',
  'bank.global_payout_uncovered': 'PRECONDITION_FAILED',
  'bank.global_payout_refused': 'PRECONDITION_FAILED',
  'bank.global_fx_unset': 'PRECONDITION_FAILED',
  'bank.global_fx_unusable': 'SERVICE_UNAVAILABLE',
  'bank.global_quote_expired': 'PRECONDITION_FAILED',
  'bank.global_quote_required': 'PRECONDITION_FAILED',
  'bank.global_quote_not_found': 'NOT_FOUND',
  'bank.global_quote_mismatch': 'BAD_REQUEST',
  'bank.global_quote_used': 'CONFLICT',
  'bank.global_travel_rule_undecided': 'PRECONDITION_FAILED',
  'bank.global_travel_rule_incomplete': 'PRECONDITION_FAILED',
  'bank.global_outcome_unknown': 'SERVICE_UNAVAILABLE',
  'bank.global_conflict': 'CONFLICT',
  'bank.global_not_found': 'NOT_FOUND',
  'bank.global_not_recallable': 'PRECONDITION_FAILED',
  'bank.global_send_not_cancellable': 'PRECONDITION_FAILED',
  'bank.global_recipient_not_found': 'NOT_FOUND',
  'bank.global_space_not_found': 'NOT_FOUND',
  'bank.global_list_limit_unset': 'BAD_REQUEST',
  'bank.global_cursor_invalid': 'BAD_REQUEST',
  'bank.global_account_format_invalid': 'BAD_REQUEST',
  'bank.global_bic_format_invalid': 'BAD_REQUEST',
  'bank.global_insufficient_funds': 'BAD_REQUEST',
  'bank.payee_controls_unset': 'PRECONDITION_FAILED',
  'bank.payee_blocked': 'PRECONDITION_FAILED',
  'bank.exchange_allowance_unset': 'PRECONDITION_FAILED',
  'bank.exchange_allowance_exceeded': 'PRECONDITION_FAILED',
  'bank.send_field_rules_unset': 'PRECONDITION_FAILED',
  'bank.reference_rules_unset': 'PRECONDITION_FAILED',
  'bank.reference_too_long': 'BAD_REQUEST',
  'bank.send_purpose_required': 'BAD_REQUEST',
  'bank.source_of_funds_required': 'BAD_REQUEST',
  'bank.receipt_not_ready': 'PRECONDITION_FAILED',
  'bank.receipt_signing_unset': 'PRECONDITION_FAILED',
  'bank.hold_not_found': 'NOT_FOUND',
  'bank.proof_limits_unset': 'PRECONDITION_FAILED',
  'bank.proof_type_not_allowed': 'BAD_REQUEST',
  'bank.proof_too_large': 'BAD_REQUEST',
  'bank.proof_invalid': 'BAD_REQUEST',
  'bank.proof_not_requested': 'PRECONDITION_FAILED',
  'bank.proof_already_uploaded': 'CONFLICT',
  'bank.space_archived': 'PRECONDITION_FAILED',
  'bank.space_locked': 'PRECONDITION_FAILED',
  'bank.step_up_required': 'PRECONDITION_FAILED',
  'bank.step_up_mismatch': 'PRECONDITION_FAILED',
  'bank.step_up_used': 'PRECONDITION_FAILED',
  'bank.step_up_unavailable': 'PRECONDITION_FAILED',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

/** A send read by its owner: anyone else is told it does not exist. */
const ONE_SEND = ['bank.global_not_found'] as const;
/** What the catalogue read refuses: no catalogue, or one this service will not read. */
const CATALOGUE = ['bank.global_corridors_unset', 'bank.global_corridors_unusable', 'bank.global_payout_unusable'] as const;

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'bank:read', module: 'bank' } as const;
const WRITE = { caller: 'scope', scope: 'bank:write', module: 'bank' } as const;
const SEND_ID = 'c4b8d2f3-5e6a-4b7c-9d0e-1f2a3b4c5d6e';
const SPACE_ID = 'd5c9e3a4-6f7b-4c8d-8e1f-2a3b4c5d6e7f';
const RECIPIENT_ID = 'e6d0f4b5-7a8c-4d9e-9f2a-3b4c5d6e7f80';
const QUOTE_ID = 'f7e1a5c6-8b9d-4e0f-8a3b-4c5d6e7f8091';
const bySendId = z.object({ id: z.string().guid() }).strict();

export const BANK_GLOBAL_PARTNER = defineProcedure({
  ...base,
  name: 'bank.global.partner',
  kind: 'query',
  path: 'global.partner',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  /** Whether a TEST stand-in answers global sends on this deployment, and its label; null standIn means it does not. */
  output: z.object({ standIn: z.string().nullable() }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_GLOBAL_CORRIDORS_LIST = defineProcedure({
  ...base,
  name: 'bank.global.corridors.list',
  kind: 'query',
  path: 'global.corridors.list',
  access: READ,
  refusals: refuse(...CATALOGUE),
  input: NO_INPUT,
  output: z.array(globalCorridorSchema),
  samples: [{ verdict: 'accept' }],
});

export const BANK_GLOBAL_RECIPIENTS_VALIDATE = defineProcedure({
  ...base,
  name: 'bank.global.recipients.validate',
  kind: 'query',
  path: 'global.recipients.validate',
  access: READ,
  refusals: refuse('bank.global_corridors_unusable'),
  input: z.object({ account: z.string().min(1).max(64), bic: z.string().max(11).optional() }).strict(),
  output: globalValidationSchema,
  samples: [
    { verdict: 'accept', input: { account: 'DE89370400440532013000' } },
    { verdict: 'accept', input: { account: 'DE89370400440532013000', bic: 'COBADEFFXXX' } },
    { verdict: 'refuse', input: { account: '' } },
    { verdict: 'refuse', input: { account: 'DE89370400440532013000', bic: 'COBADEFFXXXX' } },
  ],
});

export const BANK_GLOBAL_RECIPIENTS_ADD = defineProcedure({
  ...base,
  name: 'bank.global.recipients.add',
  kind: 'mutation',
  path: 'global.recipients.add',
  access: WRITE,
  refusals: refuse(
    'bank.personal_pay_request_invalid',
    'bank.global_account_format_invalid',
    'bank.global_bic_format_invalid',
    'bank.global_conflict',
    'bank.global_recipient_not_found',
  ),
  input: z
    .object({
      idempotencyKey: idString,
      name: z.string().min(1).max(140),
      account: z.string().min(1).max(64),
      country: z.string().length(2),
      bic: z.string().max(11).optional(),
      label: z.string().max(64).optional(),
    })
    .strict(),
  output: globalRecipientSchema,
  samples: [
    {
      verdict: 'accept',
      input: { idempotencyKey: 'global-recipient:1', name: 'Ann Example', account: 'DE89370400440532013000', country: 'DE' },
    },
    {
      verdict: 'refuse',
      input: { idempotencyKey: 'global-recipient:1', name: 'Ann Example', account: 'DE89370400440532013000', country: 'DEU' },
    },
    { verdict: 'refuse', input: { idempotencyKey: 'short', name: 'Ann Example', account: 'DE89370400440532013000', country: 'DE' } },
  ],
});

export const BANK_GLOBAL_RECIPIENTS_LIST = defineProcedure({
  ...base,
  name: 'bank.global.recipients.list',
  kind: 'query',
  path: 'global.recipients.list',
  access: READ,
  refusals: refuse('bank.global_list_limit_unset'),
  /** Optional so a missing limit reaches `bank.global_list_limit_unset`, never a default. */
  input: z.object({ limit: limitField }).strict(),
  output: z.array(globalRecipientSchema),
  samples: [
    { verdict: 'accept', input: { limit: 100 } },
    { verdict: 'refuse', input: { limit: 101 } },
  ],
});

export const BANK_GLOBAL_RECIPIENTS_REMOVE = defineProcedure({
  ...base,
  name: 'bank.global.recipients.remove',
  kind: 'mutation',
  path: 'global.recipients.remove',
  access: WRITE,
  refusals: refuse('bank.global_recipient_not_found'),
  input: z.object({ recipientId: z.string().guid(), idempotencyKey: idString }).strict(),
  output: z.object({ removed: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { recipientId: RECIPIENT_ID, idempotencyKey: 'global-recipient-remove:1' } },
    { verdict: 'refuse', input: { recipientId: 'not-a-recipient', idempotencyKey: 'global-recipient-remove:1' } },
  ],
});

/** Takes a quote and locks it: a write, since the lock is kept until the provider's valid-until. */
export const BANK_GLOBAL_QUOTE = defineProcedure({
  ...base,
  name: 'bank.global.quote',
  kind: 'mutation',
  path: 'global.quote',
  access: WRITE,
  refusals: refuse('bank.personal_pay_request_invalid', 'bank.global_fx_unset', 'bank.global_fx_unusable', 'bank.global_quote_expired'),
  input: z.object({ asset: z.string().min(1).max(16), amount, toCurrency: z.string().min(3).max(8) }).strict(),
  output: globalQuoteSchema,
  samples: [
    { verdict: 'accept', input: { asset: 'USDC', amount: '100', toCurrency: 'EUR' } },
    { verdict: 'refuse', input: { asset: 'USDC', amount: '-1', toCurrency: 'EUR' } },
  ],
});

export const BANK_GLOBAL_SEND = defineProcedure({
  ...base,
  name: 'bank.global.send',
  kind: 'mutation',
  path: 'global.send',
  access: WRITE,
  refusals: refuse(
    'bank.personal_pay_request_invalid',
    'bank.global_space_not_found',
    'bank.space_archived',
    'bank.space_locked',
    'bank.step_up_required',
    'bank.step_up_mismatch',
    'bank.step_up_used',
    'bank.step_up_unavailable',
    'bank.global_recipient_not_found',
    'bank.global_quote_not_found',
    'bank.global_quote_mismatch',
    'bank.global_quote_used',
    'bank.global_quote_required',
    'bank.global_quote_expired',
    'bank.global_conflict',
    ...CATALOGUE,
    'bank.global_corridor_unknown',
    'bank.global_amount_outside_corridor',
    'bank.global_fx_unset',
    'bank.global_payout_unset',
    'bank.global_payout_uncovered',
    'bank.global_payout_refused',
    'bank.global_travel_rule_undecided',
    'bank.global_travel_rule_incomplete',
    'bank.payee_controls_unset',
    'bank.payee_blocked',
    'bank.exchange_allowance_unset',
    'bank.exchange_allowance_exceeded',
    'bank.send_field_rules_unset',
    'bank.reference_rules_unset',
    'bank.reference_too_long',
    'bank.send_purpose_required',
    'bank.source_of_funds_required',
    'bank.global_insufficient_funds',
    'bank.global_outcome_unknown',
  ),
  input: z
    .object({
      idempotencyKey: idString,
      fromSpaceId: z.string().guid(),
      amount,
      toCurrency: z.string().min(3).max(8),
      recipientId: z.string().guid(),
      country: z.string().length(2),
      deliveryMethod: z.string().min(1).max(64),
      compliance: z.record(z.string().max(64), z.string().max(200)).optional(),
      quoteId: z.string().guid().optional(),
      stepUpApprovalId: z.string().min(1).max(128).optional(),
    })
    .strict(),
  output: globalSendSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        idempotencyKey: 'global-send:1',
        fromSpaceId: SPACE_ID,
        amount: '100',
        toCurrency: 'EUR',
        recipientId: RECIPIENT_ID,
        country: 'DE',
        deliveryMethod: 'bank_account',
        quoteId: QUOTE_ID,
        stepUpApprovalId: 'approval-1',
      },
    },
    {
      verdict: 'refuse',
      input: {
        idempotencyKey: 'global-send:1',
        fromSpaceId: SPACE_ID,
        amount: '1e3',
        toCurrency: 'EUR',
        recipientId: RECIPIENT_ID,
        country: 'DE',
        deliveryMethod: 'bank_account',
      },
    },
  ],
});

export const BANK_GLOBAL_LIST = defineProcedure({
  ...base,
  name: 'bank.global.list',
  kind: 'query',
  path: 'global.list',
  access: READ,
  refusals: refuse('bank.global_list_limit_unset', 'bank.global_cursor_invalid'),
  /** Optional so a missing limit reaches `bank.global_list_limit_unset`, never a default. */
  input: z.object({ limit: limitField, cursor: z.string().min(1).max(512).optional() }).strict(),
  output: z.object({ items: z.array(globalSendSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const BANK_GLOBAL_HOLD_GET = defineProcedure({
  ...base,
  name: 'bank.global.hold.get',
  kind: 'query',
  path: 'global.hold.get',
  access: READ,
  refusals: refuse(...ONE_SEND, 'bank.hold_not_found'),
  input: bySendId,
  output: globalCustomerHoldSchema,
  samples: [
    { verdict: 'accept', input: { id: SEND_ID } },
    { verdict: 'refuse', input: { id: 'not-a-send' } },
  ],
});

export const BANK_GLOBAL_HOLD_UPLOAD_PROOF = defineProcedure({
  ...base,
  name: 'bank.global.hold.uploadProof',
  kind: 'mutation',
  path: 'global.hold.uploadProof',
  access: WRITE,
  refusals: refuse(
    ...ONE_SEND,
    'bank.hold_not_found',
    'bank.proof_limits_unset',
    'bank.proof_type_not_allowed',
    'bank.proof_too_large',
    'bank.proof_invalid',
    'bank.proof_not_requested',
    'bank.proof_already_uploaded',
  ),
  input: z
    .object({
      id: z.string().guid(),
      name: z.string().min(1).max(200),
      type: z.string().min(3).max(100),
      contentBase64: z.string().min(4).max(40_000_000),
    })
    .strict(),
  output: globalCustomerHoldSchema,
  samples: [
    { verdict: 'accept', input: { id: SEND_ID, name: 'invoice.pdf', type: 'application/pdf', contentBase64: 'JVBERi0x' } },
    { verdict: 'refuse', input: { id: SEND_ID, name: 'invoice.pdf', type: 'application/pdf', contentBase64: '' } },
  ],
});

/** Cancel a send while it is on hold with nothing posted. Nothing moves, so no step-up. */
export const BANK_GLOBAL_CANCEL = defineProcedure({
  ...base,
  name: 'bank.global.cancel',
  kind: 'mutation',
  path: 'global.cancel',
  access: WRITE,
  refusals: refuse(...ONE_SEND, 'bank.global_send_not_cancellable'),
  input: bySendId,
  output: globalSendSchema,
  samples: [
    { verdict: 'accept', input: { id: SEND_ID } },
    { verdict: 'refuse', input: { id: SEND_ID, reason: 'extra' } },
  ],
});

/** Ask for a send that left to come back (wrong person or wrong details). Nothing moves, so no step-up. */
export const BANK_GLOBAL_RECALL = defineProcedure({
  ...base,
  name: 'bank.global.recall',
  kind: 'mutation',
  path: 'global.recall',
  access: WRITE,
  refusals: refuse('bank.personal_pay_request_invalid', ...ONE_SEND, 'bank.global_not_recallable'),
  input: z.object({ id: z.string().guid(), reason: z.string().min(1).max(500) }).strict(),
  output: globalSendSchema,
  samples: [
    { verdict: 'accept', input: { id: SEND_ID, reason: 'Wrong account number' } },
    { verdict: 'refuse', input: { id: SEND_ID, reason: '' } },
  ],
});

export const BANK_GLOBAL_RECEIPT = defineProcedure({
  ...base,
  name: 'bank.global.receipt',
  kind: 'query',
  path: 'global.receipt',
  access: READ,
  refusals: refuse(...ONE_SEND, 'bank.receipt_not_ready', 'bank.receipt_signing_unset', 'bank.global_recipient_not_found'),
  input: bySendId,
  output: globalReceiptSchema,
  samples: [
    { verdict: 'accept', input: { id: SEND_ID } },
    { verdict: 'refuse', input: { id: 'not-a-send' } },
  ],
});

export const BANK_GLOBAL_PROCEDURES = [
  BANK_GLOBAL_PARTNER,
  BANK_GLOBAL_CORRIDORS_LIST,
  BANK_GLOBAL_RECIPIENTS_VALIDATE,
  BANK_GLOBAL_RECIPIENTS_ADD,
  BANK_GLOBAL_RECIPIENTS_LIST,
  BANK_GLOBAL_RECIPIENTS_REMOVE,
  BANK_GLOBAL_QUOTE,
  BANK_GLOBAL_SEND,
  BANK_GLOBAL_LIST,
  BANK_GLOBAL_HOLD_GET,
  BANK_GLOBAL_HOLD_UPLOAD_PROOF,
  BANK_GLOBAL_CANCEL,
  BANK_GLOBAL_RECALL,
  BANK_GLOBAL_RECEIPT,
] as const;
