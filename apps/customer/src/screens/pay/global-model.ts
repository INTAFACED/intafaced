// hand-declared-ok: svc-bank declares the global.* answers inline in its router, not in packages/contracts yet
import { z } from 'zod';

// The shapes `svc-bank` answers on `global.*` (services/svc-bank/src/personal-pay/router.ts). Hand-declared here, like the
// rest of the Pay screen's answers; a wrong shape is refused rather than shown.
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/);
export const corridorSchema = z.object({
  country: z.string(),
  currency: z.string(),
  deliveryMethods: z.array(z.string()),
  minAmount: amount.nullable(),
  maxAmount: amount.nullable(),
  cutOffTime: z.string().nullable(),
});
export const recipientSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  name: z.string(),
  account: z.string(),
  accountKind: z.enum(['iban', 'ifsc', 'account_number']),
  bic: z.string().nullable(),
  country: z.string(),
  createdAt: z.string(),
});
export const validationSchema = z.object({
  format: z.enum(['valid', 'invalid']),
  formatKind: z.enum(['iban', 'ifsc', 'account_number']).nullable(),
  normalized: z.string().nullable(),
  bicLookup: z.object({ status: z.string() }).passthrough(),
});
export const quoteSchema = z.object({
  rate: amount,
  fee: amount,
  feeAsset: z.string(),
  receiveAmount: amount,
  validUntil: z.string(),
  eta: z.string(),
});
export const sendSchema = z.object({
  id: z.string(),
  fromSpaceId: z.string(),
  assetId: z.string(),
  amount,
  toCurrency: z.string(),
  recipientId: z.string(),
  country: z.string(),
  deliveryMethod: z.string(),
  status: z.enum(['submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed', 'cancelled']),
  failureCode: z.string().nullable(),
  failureBlocker: z.string().nullable(),
  providerRef: z.string().nullable(),
  quoteRate: z.string().nullable(),
  quoteFee: z.string().nullable(),
  quoteFeeAsset: z.string().nullable(),
  quoteReceive: z.string().nullable(),
  quoteValidUntil: z.string().nullable(),
  quoteEta: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  cancelledBy: z.enum(['customer', 'auto']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const removedSchema = z.object({ removed: z.literal(true) });
export const holdSchema = z.object({
  state: z.enum(['requested', 'under_review', 'released', 'cancelled']),
  infoRequest: z.string().nullable(),
  proofUploaded: z.boolean(),
  proofLimits: z.object({ allowedTypes: z.array(z.string()), maxBytes: z.number().int().positive() }).nullable(),
  /** The owner's auto-cancel rule for a send on hold, and when it cancels this one (null when unset or closed). */
  autoCancel: z.object({ state: z.enum(['unset', 'published']), hours: z.number().nullable(), at: z.string().nullable() }),
});
/** The signed receipt of a send that left: the file's text, its SHA-256, the signature and the ledger transaction. */
export const receiptSchema = z.object({
  fileName: z.string(),
  text: z.string(),
  ledgerTxId: z.string(),
  sha256: z.string(),
  signature: z.string(),
});
export const sendPageSchema = z.object({ items: z.array(sendSchema), nextCursor: z.string().nullable() });

export type Corridor = z.infer<typeof corridorSchema>;
export type Recipient = z.infer<typeof recipientSchema>;
export type GlobalQuote = z.infer<typeof quoteSchema>;
export type GlobalSend = z.infer<typeof sendSchema>;
export type GlobalHold = z.infer<typeof holdSchema>;
export type GlobalReceipt = z.infer<typeof receiptSchema>;

/** One row of the destination list: a country and currency with one delivery method. */
export type Destination = { key: string; country: string; currency: string; method: string; corridor: Corridor };
export function destinationsFrom(corridors: readonly Corridor[]): Destination[] {
  return corridors.flatMap((corridor) =>
    corridor.deliveryMethods.map((method) => ({
      key: `${corridor.country}|${corridor.currency}|${method}`,
      country: corridor.country,
      currency: corridor.currency,
      method,
      corridor,
    })),
  );
}

/** Which of the three extra fields the service has asked for, read from its refusal codes. */
export type ComplianceField = 'purpose' | 'sourceOfFunds' | 'reference';
export const COMPLIANCE_CODES: Readonly<Record<string, ComplianceField>> = {
  'bank.send_purpose_required': 'purpose',
  'bank.source_of_funds_required': 'sourceOfFunds',
  'bank.reference_too_long': 'reference',
};
export const askedField = (code: string | undefined): ComplianceField | null => (code ? (COMPLIANCE_CODES[code] ?? null) : null);

/**
 * The `compliance` map exactly as the service canonicalises it for the step-up hash: keys sorted, values trimmed, empty
 * values dropped, and an empty map is the empty string. The confirmation and the send must carry the same bytes.
 */
export function canonicalCompliance(fields: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key]?.trim() ?? '';
    if (value) sorted[key] = value;
  }
  return Object.keys(sorted).length === 0 ? '' : JSON.stringify(sorted);
}
export function complianceMap(fields: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const text = canonicalCompliance(fields);
  return text ? (JSON.parse(text) as Record<string, string>) : undefined;
}

export type SendDraft = {
  idempotencyKey: string;
  fromSpaceId: string;
  assetId: string;
  amount: string;
  toCurrency: string;
  recipientId: string;
  country: string;
  deliveryMethod: string;
  compliance: Readonly<Record<string, string>>;
};

/** The body of `global.send`, with the value forms the confirmation was bound to. */
export function sendInput(draft: SendDraft, stepUpApprovalId: string) {
  const compliance = complianceMap(draft.compliance);
  return {
    idempotencyKey: draft.idempotencyKey,
    fromSpaceId: draft.fromSpaceId,
    amount: draft.amount,
    toCurrency: draft.toCurrency,
    recipientId: draft.recipientId,
    country: draft.country,
    deliveryMethod: draft.deliveryMethod,
    ...(compliance ? { compliance } : {}),
    stepUpApprovalId,
  };
}

/** The request `stepUp.begin` takes for this send (`CUSTOMER_STEP_UP_DOORS`, scope `bank.step_up.global.send`). */
export function sendStepUpRequest(draft: SendDraft) {
  return {
    scope: 'bank.step_up.global.send',
    purpose: 'global.send',
    amount: draft.amount,
    target: draft.recipientId,
    fields: {
      idempotencyKey: draft.idempotencyKey,
      fromSpaceId: draft.fromSpaceId,
      assetId: draft.assetId,
      amount: draft.amount,
      toCurrency: draft.toCurrency,
      recipientId: draft.recipientId,
      country: draft.country,
      deliveryMethod: draft.deliveryMethod,
      compliance: canonicalCompliance(draft.compliance),
    },
  };
}

/** True for a plain decimal above zero: the only amounts this form sends. */
export const isPositiveAmount = (text: string): boolean => /^\d+(\.\d{1,18})?$/.test(text) && /[1-9]/.test(text);

/** Business key of saving a recipient: the same account in the same country is the same recipient. */
export const recipientKey = (userId: string, country: string, account: string): string =>
  `global-recipient:${userId}:${country.toUpperCase()}:${account.replace(/\s+/g, '').toUpperCase()}`;

const STATUS_ORDER = ['submitted', 'sent', 'on_the_way', 'arrived'] as const;
/** How far a send has got along Sent, On its way, Arrived (0 to 3 steps done); a failed or cancelled send has none. */
export const progressOf = (status: GlobalSend['status']): number =>
  status === 'failed' || status === 'held' || status === 'cancelled' ? 0 : STATUS_ORDER.indexOf(status);
/** A send that left the account: the only kind with a receipt. */
export const hasLeft = (status: GlobalSend['status']): boolean => status === 'sent' || status === 'on_the_way' || status === 'arrived';

const scaled = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
};
/** Compares two decimal strings without a float: -1, 0 or 1. */
export const compareAmounts = (a: string, b: string): number => (scaled(a) < scaled(b) ? -1 : scaled(a) > scaled(b) ? 1 : 0);

/** What is wrong with an amount for a destination, or null when it is inside the destination's published limits. */
export function amountProblem(text: string, corridor: Corridor | null): 'empty' | 'belowMinimum' | 'aboveMaximum' | null {
  if (!isPositiveAmount(text)) return 'empty';
  if (corridor?.minAmount && compareAmounts(text, corridor.minAmount) < 0) return 'belowMinimum';
  if (corridor?.maxAmount && compareAmounts(text, corridor.maxAmount) > 0) return 'aboveMaximum';
  return null;
}

/** The three fields as the service asked for them, kept apart from fields it has not asked for. */
export const COMPLIANCE_FIELDS: readonly ComplianceField[] = ['purpose', 'sourceOfFunds', 'reference'];

/** Why a chosen file cannot be sent, judged only by the limits the service published; null means it may be sent. */
export function proofProblem(
  file: { type: string; size: number },
  limits: GlobalHold['proofLimits'],
): 'noLimits' | 'type' | 'empty' | 'size' | null {
  if (!limits) return 'noLimits';
  if (file.size === 0) return 'empty';
  if (!limits.allowedTypes.includes(file.type.toLowerCase())) return 'type';
  if (file.size > limits.maxBytes) return 'size';
  return null;
}
