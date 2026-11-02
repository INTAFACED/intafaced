import {
  SUPPORT_DISCLOSURE_KINDS,
  SUPPORT_DISCLOSURE_OWNER,
  SUPPORT_VERIFICATION_CHECK_KINDS,
  SUPPORT_VERIFICATION_CHECK_OWNER,
  SUPPORT_VERIFICATION_RECORD_KINDS,
  supportRecordVerificationCheckInputSchema,
  type SupportDisclosureKind,
  type SupportVerificationCheckKind,
  type SupportVerificationChecks,
} from '@intafaced/contracts/support-verification-checks';
import type { FounderCallFailure } from '@/lib/desk/founder-call';
import type { Part } from '@/lib/desk/part';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { explainSupportFailure, supportCodeOf } from './refusal';
import { isTicketId } from './model';

/**
 * Balance disclosure gate on the desk (RC-support-public-01, J-support-public-20 #2): what the "Verify the customer" card
 * sends and how it reads svc-support's answers. Pure, so the route and the card share it and it is tested without a server.
 */

export type { SupportVerificationChecks };
export const CHECK_KINDS = SUPPORT_VERIFICATION_CHECK_KINDS;
export const CHECK_OWNER = SUPPORT_VERIFICATION_CHECK_OWNER;
export const RECORD_KINDS = SUPPORT_VERIFICATION_RECORD_KINDS;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const DISCLOSURES = SUPPORT_DISCLOSURE_KINDS;
export const DISCLOSURE_OWNER = SUPPORT_DISCLOSURE_OWNER;
export type Disclosure = SupportDisclosureKind;

export const CHECK_KIND_WORDS: Readonly<Record<SupportVerificationCheckKind, string>> = {
  email: 'Email',
  client_order_id: 'Client order id',
  withdrawal_id: 'Withdrawal id',
  deposit_id: 'Deposit id',
};

export const DISCLOSURE_WORDS: Readonly<Record<Disclosure, string>> = {
  balance: 'Read the balance',
  fills: 'Read the fills',
  destination: 'Read the withdrawal destination',
};

export interface SupportVerificationView {
  readonly asOf: string;
  readonly checks: Part<SupportVerificationChecks>;
}

export type VerificationRequest =
  | { readonly action: 'check'; readonly ticketId: string; readonly kind: SupportVerificationCheckKind; readonly value: string }
  | { readonly action: 'disclosure'; readonly ticketId: string; readonly what: Disclosure };

/** Whether a value is the shape svc-support takes for that kind (an email, a client order id, or a uuid). */
export function isCheckValue(kind: SupportVerificationCheckKind, value: unknown): value is string {
  return supportRecordVerificationCheckInputSchema.safeParse({ ticketId: '00000000-0000-4000-8000-000000000000', kind, value }).success;
}

/** What the browser may ask the route for. Anything else is refused before anything is sent. */
export function readVerificationRequest(raw: Record<string, unknown>): VerificationRequest | null {
  if (!isTicketId(raw.ticketId)) return null;
  const ticketId = raw.ticketId.toLowerCase();
  if (raw.action === 'check') {
    if (!(CHECK_KINDS as readonly unknown[]).includes(raw.kind)) return null;
    const kind = raw.kind as SupportVerificationCheckKind;
    if (!isCheckValue(kind, raw.value)) return null;
    return { action: 'check', ticketId, kind, value: raw.value.trim() };
  }
  if (raw.action === 'disclosure') {
    if (!(DISCLOSURES as readonly unknown[]).includes(raw.what)) return null;
    return { action: 'disclosure', ticketId, what: raw.what as Disclosure };
  }
  return null;
}

type Entry = Omit<RefusalView, 'code' | 'changed'>;

const BY_CODE: Readonly<Record<string, (detail: string) => Entry>> = {
  'support.verification_checks_required': (detail) => ({
    title: 'The customer’s email and one of their record ids are needed first',
    body: `svc-support refused to read it: ${detail || 'the two checks are not matched'}. Nothing was read.`,
    next: 'Ask the customer for the email on their account and the id of one of their own orders, withdrawals or deposits, and record each.',
  }),
  'support.disclosure_unwired': (detail) => ({
    title: `${detail || 'The owning service'} serves the desk no door for this yet`,
    body: `svc-support would ask ${detail || 'the service that owns it'}, which gives the desk no answer yet. Nothing was stored and nothing was read.`,
    next: 'Nothing was changed. Escalate as a money request if the customer needs an answer now.',
  }),
  'support.verification_mismatch': () => ({
    title: 'That does not match',
    body: 'A check was stored as not matching, and it counts toward this request’s attempts. Nothing was read.',
    next: 'Ask the customer again; the same value will not be asked twice. Never tell them which part did not match.',
  }),
  'support.verification_attempts_unset': () => ({
    title: 'The number of check attempts is not set',
    body: 'The owner has not set how many checks one request may take (SUPPORT_VERIFICATION_ATTEMPTS), so no check is taken. Nothing was stored.',
    next: 'The owner sets it; until then the gate stays shut.',
  }),
  'support.verification_attempts_exhausted': (detail) => ({
    title: 'This request has used every check attempt',
    body: `It has taken the ${detail || 'allowed'} attempts the owner allows. Nothing was stored.`,
    next: 'Escalate the request; do not open a new one to try again.',
  }),
};

/** The text svc-support put after its code: the owner it waits on, or how many checks are matched. */
export function detailAfter(code: string, message: string): string {
  const at = message.indexOf(code);
  return at < 0 ? '' : message.slice(at + code.length).trim();
}

/** A refusal on the gate: its own codes with their detail first, then the desk's general answers. */
export function explainVerificationFailure(result: FounderCallFailure<unknown>): RefusalView {
  if (result.kind === 'refused' || result.kind === 'forbidden') {
    const code = supportCodeOf(result.refusal.message, result.refusal.code);
    const entry = code ? BY_CODE[code] : undefined;
    if (code && entry) return { ...entry(detailAfter(code, result.refusal.message)), code, changed: 'no' };
  }
  return explainSupportFailure(result);
}

export type VerificationReply = { readonly ok: true; readonly summary: string } | { readonly ok: false; readonly refusal: RefusalView };
