import { z } from 'zod';
import type { ServiceName } from './service-keys.js';
import { guestNotificationReceiptSchema, type GuestNotificationReceipt } from './guest-notifications.js';

/**
 * Guest verification email: svc-support asks svc-notify to mail a guest the link that opens their support request
 * (SP-tickets-01, J-support-public-03). ADR 2026-10-22 §3.5: a door of its own, beside svc-ops's guest route and never
 * shared with it, so neither producer can read or erase the other's rows.
 *
 * Browser-safe: zod only at run time (the service name import is type-only).
 *
 * THE LINK IS NEVER STORED. It carries the token the guest proves the address with, so svc-notify keeps the token's id and
 * expiry only and renders the link into the email at send time. A resend is a new send under the next ordinal, with a
 * fresh link from svc-support. The link must start with svc-notify's configured customer app origin; a blank origin
 * refuses (`guest.link_origin_unset`), and a link anywhere else refuses (`guest.link_origin_mismatch`).
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

/** `support:guest-verify:<guestRequestId>:<ordinal>`: one key per link sent, the ordinal counting resends from 1. */
export const GUEST_VERIFICATION_KEY = /^support:guest-verify:([0-9a-fA-F-]{36}):([1-9][0-9]{0,3})$/;
export const guestVerificationKey = (requestId: string, ordinal: number) => `support:guest-verify:${requestId}:${ordinal}`;

export const GUEST_VERIFICATION_LINK_MAX = 2048;

export const guestVerificationSendInputSchema = z
  .object({
    businessKey: z.string().regex(GUEST_VERIFICATION_KEY),
    guestRequestId,
    recipientEmail: z.string().email().max(320),
    /** Rendered into the email and dropped: never stored. */
    link: z.string().url().max(GUEST_VERIFICATION_LINK_MAX),
    /** The id of the token the link carries (not the token), kept with the row. */
    tokenId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const key = GUEST_VERIFICATION_KEY.exec(value.businessKey);
    if (key && key[1]!.toLowerCase() !== value.guestRequestId.toLowerCase())
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['businessKey'], message: 'the key names another request' });
    if (!/^https?:\/\//.test(value.link))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['link'], message: 'the link is a web address' });
  });
export type GuestVerificationSendInput = z.infer<typeof guestVerificationSendInputSchema>;

export const guestVerificationGetInputSchema = z.object({ businessKey: z.string().regex(GUEST_VERIFICATION_KEY) }).strict();
export type GuestVerificationGetInput = z.infer<typeof guestVerificationGetInputSchema>;

/** Erase the address of every verification row for one guest request; a tombstone refuses later sends. */
export const guestVerificationEraseInputSchema = z.object({ guestRequestId }).strict();
export const guestVerificationEraseReceiptSchema = z
  .object({
    guestRequestId,
    erasedCount: z.number().int().safe().nonnegative(),
    erasedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type GuestVerificationEraseReceipt = z.infer<typeof guestVerificationEraseReceiptSchema>;

/** The same receipt as the guest route: acceptance by the gateway is evidence of acceptance, never of arrival. */
export const guestVerificationReceiptSchema = guestNotificationReceiptSchema;
export type GuestVerificationReceipt = GuestNotificationReceipt;
