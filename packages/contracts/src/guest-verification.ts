import { z } from 'zod';
import type { ServiceName } from './service-keys.js';
import type { Context } from './trpc.js';
import { guestReceiptEvidence } from './guest-notifications.js';

/**
 * Guest verification email: svc-support asks svc-notify to mail a guest the link that opens their support request
 * (SP-tickets-01, J-support-public-03). ADR 2026-10-22 §3.5: a door of its own, beside svc-ops's guest route and never
 * shared with it, so neither producer can read or erase the other's rows, and each has its own codes.
 *
 * Browser-safe: zod only at run time (the service name and context imports are type-only).
 *
 * THE LINK IS NEVER STORED. It carries the token the guest proves the address with, so svc-notify keeps the token's id and
 * expiry only and renders the link into the email at send time. A resend is a new send under the next ordinal, with a
 * fresh link from svc-support.
 *
 * THE LINK GOES ONLY TO THE CUSTOMER APP. Its origin (scheme, host and port, parsed as a URL) must equal svc-notify's
 * configured customer app origin exactly, never a prefix of it: a blank origin refuses `guest.link_origin_unset`, any other
 * origin `guest.link_origin_mismatch` (`guestVerificationLinkMatches`). The schema already refuses a link with a user part
 * and a plain-http link anywhere but a local host, so a token never travels in clear text off the machine.
 *
 * NO SENDER IS A REFUSAL, NOT A SEND. With no email sender configured the receipt is refused with
 * `guest.notification_unconfigured`; svc-support shows that to the guest as `vendor.email` and keeps its request pending.
 */

/** The tRPC paths on svc-notify's root router. */
export const GUEST_VERIFICATION_PROCEDURES = {
  send: 'guestVerification.send',
  get: 'guestVerification.get',
  erase: 'guestVerification.erase',
} as const;

/** The only service allowed to call them. Passed to `serviceProcedureFor`; enforced under either S2S mode. */
export const GUEST_VERIFICATION_CALLERS: readonly ServiceName[] = ['svc-support'];

const guestRequestId = z.string().guid();
const timestamp = z.string().datetime({ offset: true });

/** `support:guest-verify:<guestRequestId>:<ordinal>`: one key per link sent, the ordinal counting sends from 1. */
export const GUEST_VERIFICATION_KEY = /^support:guest-verify:([0-9a-fA-F-]{36}):([1-9][0-9]{0,3})$/;
export const GUEST_VERIFICATION_ORDINAL_MAX = 9999;

export function guestVerificationKey(requestId: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > GUEST_VERIFICATION_ORDINAL_MAX)
    throw new RangeError(`a guest verification ordinal is a whole number from 1 to ${GUEST_VERIFICATION_ORDINAL_MAX}`);
  return `support:guest-verify:${requestId}:${ordinal}`;
}

export const GUEST_VERIFICATION_LINK_MAX = 2048;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why a link cannot be mailed, before any origin is compared; null when its shape is fine. */
export function guestVerificationLinkProblem(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return 'the link is not a web address';
  }
  if (url.username !== '' || url.password !== '') return 'the link carries a user part';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return null;
  return 'the link is https, or http on this machine only';
}

/** True when the link's origin is exactly the configured customer app origin. A blank origin matches nothing. */
export function guestVerificationLinkMatches(link: string, origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(link).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export const guestVerificationSendInputSchema = z
  .object({
    businessKey: z.string().regex(GUEST_VERIFICATION_KEY),
    guestRequestId,
    recipientEmail: z.string().email().max(320),
    /** Rendered into the email and dropped: never stored. */
    link: z.string().max(GUEST_VERIFICATION_LINK_MAX),
    /** The id of the token the link carries (not the token), kept with the row. */
    tokenId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    /** When the link stops working. svc-notify refuses a send whose link has already expired (`guest.link_expired`). */
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    const key = GUEST_VERIFICATION_KEY.exec(value.businessKey);
    if (key && key[1]!.toLowerCase() !== value.guestRequestId.toLowerCase())
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['businessKey'], message: 'the key names another request' });
    const problem = guestVerificationLinkProblem(value.link);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['link'], message: problem });
  });
export type GuestVerificationSendInput = z.infer<typeof guestVerificationSendInputSchema>;

export const guestVerificationGetInputSchema = z.object({ businessKey: z.string().regex(GUEST_VERIFICATION_KEY) }).strict();
export type GuestVerificationGetInput = z.infer<typeof guestVerificationGetInputSchema>;

/** Erase the address of every verification row for one guest request; a tombstone refuses later sends. */
export const guestVerificationEraseInputSchema = z.object({ guestRequestId }).strict();
export type GuestVerificationEraseInput = z.infer<typeof guestVerificationEraseInputSchema>;
export const guestVerificationEraseReceiptSchema = z
  .object({
    guestRequestId,
    erasedCount: z.number().int().safe().nonnegative(),
    erasedAt: timestamp,
  })
  .strict();
export type GuestVerificationEraseReceipt = z.infer<typeof guestVerificationEraseReceiptSchema>;

/** The codes this door answers. The ops route's own codes (a submission erased) are not among them. */
export const guestVerificationCodeSchema = z.enum([
  'guest.notification_unconfigured',
  'guest.configuration_unverified',
  'guest.request_conflict',
  'guest.gateway_refused',
  'guest.acceptance_unknown',
  'guest.storage_unavailable',
  'guest.address_rate_limited',
  'guest.delivery_in_progress',
  'guest.link_origin_unset',
  'guest.link_origin_mismatch',
  'guest.link_expired',
  'guest.request_erased',
]);
export type GuestVerificationCode = z.infer<typeof guestVerificationCodeSchema>;

/** Acceptance by the gateway is evidence of acceptance, never of arrival: the same evidence rules as the ops route. */
export const guestVerificationReceiptSchema = z
  .object({
    notificationId: z.string().guid(),
    businessKey: z.string().regex(GUEST_VERIFICATION_KEY),
    status: z.enum(['queued', 'attempting', 'accepted', 'refused', 'unresolved']),
    attemptedAt: timestamp.nullable(),
    acceptedAt: timestamp.nullable(),
    code: guestVerificationCodeSchema.nullable(),
    reference: z.string().max(256).nullable(),
  })
  .strict()
  .superRefine(guestReceiptEvidence);
export type GuestVerificationReceipt = z.infer<typeof guestVerificationReceiptSchema>;

/** svc-notify serves it; svc-support calls it. Every call is the caller's own rows only. */
export interface GuestVerificationContract {
  send(context: Context, input: GuestVerificationSendInput): Promise<GuestVerificationReceipt>;
  /** The receipt for one key the caller sent, or null when it sent none under that key. */
  get(context: Context, input: GuestVerificationGetInput): Promise<GuestVerificationReceipt | null>;
  /** Erase the recipient of one guest request's rows; later sends for it refuse `guest.request_erased`. */
  erase(context: Context, input: GuestVerificationEraseInput): Promise<GuestVerificationEraseReceipt>;
}
