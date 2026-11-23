import type { GlobalCorridor as Corridor, GlobalHold, GlobalQuote, GlobalSend } from '@intafaced/contracts/bank-global-procedures';

// The answers of `global.*` are svc-bank's own records (`@intafaced/contracts/bank-global-procedures`); this file holds
// only what the Pay screen works out from them.
export type {
  GlobalCorridor as Corridor,
  GlobalHold,
  GlobalQuote,
  GlobalReceipt,
  GlobalRecipient as Recipient,
  GlobalSend,
} from '@intafaced/contracts/bank-global-procedures';

/** One row of the destination list: a country and currency with one delivery method. */
export type Destination = { key: string; country: string; currency: string; method: string; paysOut: boolean; corridor: Corridor };
/**
 * A country typed by hand, checked against the published catalogue: `bad` when it is not a two-letter code, `supported`
 * when any corridor goes there, else `unsupported`. Nothing but the catalogue decides it.
 */
export function corridorFor(
  corridors: readonly Corridor[],
  typed: string,
): { country: string; state: 'bad' | 'supported' | 'unsupported' } {
  const country = typed.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { country, state: 'bad' };
  return { country, state: corridors.some((row) => row.country === country) ? 'supported' : 'unsupported' };
}

export function destinationsFrom(corridors: readonly Corridor[]): Destination[] {
  return corridors.flatMap((corridor) =>
    corridor.deliveryMethods.map((method) => ({
      key: `${corridor.country}|${corridor.currency}|${method}`,
      country: corridor.country,
      currency: corridor.currency,
      method,
      paysOut: corridor.payoutMethods.includes(method),
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
  /** The rate lock the person confirmed. */
  quoteId: string;
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
    quoteId: draft.quoteId,
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
      quoteId: draft.quoteId,
    },
  };
}

/**
 * When a rate lock ends on this device's clock: the lock's own length (`validUntil - lockedAt`, both the service's
 * clock) counted from when the quote was asked for, so a device clock that is wrong neither ends it early nor keeps it
 * late. NaN when either time cannot be read, which reads as run out.
 */
export const lockDeadline = (quote: Pick<GlobalQuote, 'validUntil' | 'lockedAt'>, askedAt: number): number =>
  askedAt + (Date.parse(quote.validUntil) - Date.parse(quote.lockedAt));

/** What is left of a rate lock at `now`, as m:ss, or null once it has run out (or cannot be read). */
export function lockLeft(deadline: number, now: number): string | null {
  const left = Math.ceil((deadline - now) / 1000);
  if (!Number.isFinite(left) || left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** True for a plain decimal above zero: the only amounts this form sends. */
export const isPositiveAmount = (text: string): boolean => /^\d+(\.\d{1,18})?$/.test(text) && /[1-9]/.test(text);

/** Business key of saving a recipient: the same account in the same country is the same recipient. */
export const recipientKey = (userId: string, country: string, account: string): string =>
  `global-recipient:${userId}:${country.toUpperCase()}:${account.replace(/\s+/g, '').toUpperCase()}`;

const STATUS_ORDER = ['submitted', 'sent', 'on_the_way', 'arrived'] as const;
/** How far a send has got along Sent, On its way, Arrived (0 to 3 steps done); a send that never left has none. */
export const progressOf = (status: GlobalSend['status']): number =>
  Math.max(0, STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]));
/** A send that left the account: the only kind with a receipt, including one the rail later sent back. */
export const hasLeft = (status: GlobalSend['status']): boolean =>
  status === 'sent' || status === 'on_the_way' || status === 'arrived' || status === 'returned' || status === 'refunded';
/** A send that left and has not come back: the only kind its customer can ask back. */
export const canRecall = (status: GlobalSend['status']): boolean => status === 'sent' || status === 'on_the_way' || status === 'arrived';

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
