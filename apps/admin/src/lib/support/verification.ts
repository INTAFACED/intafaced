import {
  SUPPORT_CHECK_RECORD_KINDS,
  SUPPORT_CHECK_RECORD_OWNER,
  type SupportCheckRecordKind,
  type SupportVerificationChecks,
} from '@intafaced/contracts/support-verification-checks';
import type { FounderCallFailure } from '@/lib/desk/founder-call';
import type { Part } from '@/lib/desk/part';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { explainSupportFailure, supportCodeOf } from './refusal';

/**
 * Balance disclosure gate on the desk (RC-support-public-01, J-support-public-20 #2): what the panel sends and how it reads
 * svc-support's answers. Pure, so the route and the panel share it and it is tested without a server.
 */

export type { SupportVerificationChecks };
export const CHECK_RECORD_KINDS = SUPPORT_CHECK_RECORD_KINDS;
export const CHECK_RECORD_OWNER = SUPPORT_CHECK_RECORD_OWNER;

export const RECORD_KIND_WORDS: Readonly<Record<SupportCheckRecordKind, string>> = {
  order: 'Order',
  withdrawal: 'Withdrawal',
  deposit: 'Deposit',
};

/** The two reads behind the gate. */
export const DISCLOSURES = ['balance', 'withdrawal_destination'] as const;
export type Disclosure = (typeof DISCLOSURES)[number];
export const DISCLOSURE_PROCEDURE: Readonly<Record<Disclosure, string>> = {
  balance: 'customerBalance',
  withdrawal_destination: 'customerWithdrawalDestination',
};

export interface SupportVerificationView {
  readonly asOf: string;
  readonly checks: Part<SupportVerificationChecks>;
}

export type VerificationRequest =
  | { readonly action: 'check'; readonly ticketId: string; readonly recordKind: SupportCheckRecordKind; readonly recordId: string }
  | { readonly action: 'disclosure'; readonly ticketId: string; readonly what: Disclosure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value.trim());

/** What the browser may ask the route for. Anything else is refused before anything is sent. */
export function readVerificationRequest(raw: Record<string, unknown>): VerificationRequest | null {
  if (!isUuid(raw.ticketId)) return null;
  const ticketId = raw.ticketId.trim().toLowerCase();
  if (raw.action === 'check') {
    if (!(CHECK_RECORD_KINDS as readonly unknown[]).includes(raw.recordKind) || !isUuid(raw.recordId)) return null;
    return { action: 'check', ticketId, recordKind: raw.recordKind as SupportCheckRecordKind, recordId: raw.recordId.trim().toLowerCase() };
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
    title: 'Two checks the customer can confirm are needed first',
    body: `svc-support refused to read it: ${detail || 'fewer than two checks are recorded'}. Nothing was read.`,
    next: 'Ask the customer for the ids of two of their own records and record each as a check.',
  }),
  'support.verification_check_owner_unwired': (detail) => ({
    title: `${detail || 'The owning service'} cannot confirm records yet`,
    body: `svc-support asks ${detail || 'the service that owns the record'} whether a record is the customer's, and it gives no answer yet. No check was recorded.`,
    next: 'Nothing was changed. This check works once that service answers.',
  }),
  'support.verification_check_owner_unreachable': (detail) => ({
    title: `${detail || 'The owning service'} did not answer`,
    body: 'svc-support got no verified answer on whether the record is the customer’s. No check was recorded.',
    next: 'Nothing was changed. Try again in a moment.',
  }),
  'support.verification_check_not_owned': () => ({
    title: 'That record is not this customer’s',
    body: 'Its owner says the record does not belong to the customer on this request, or it does not exist. No check was recorded.',
    next: 'Check the id with the customer. Never read another customer’s record from this request.',
  }),
  'support.balance_read_unwired': () => ({
    title: 'The desk has no balance read',
    body: 'The checks are recorded, but svc-support cannot read a balance. Nothing was read.',
    next: 'Escalate as a money request if the customer needs an answer about their balance.',
  }),
  'support.withdrawal_destination_read_unwired': () => ({
    title: 'The desk has no withdrawal destination read',
    body: 'The checks are recorded, but svc-support cannot read a withdrawal destination. Nothing was read.',
    next: 'Escalate as a money request if the customer needs an answer about where a withdrawal went.',
  }),
};

/** The text svc-support put after its code: the owner it waits on, or how many checks are recorded. */
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
