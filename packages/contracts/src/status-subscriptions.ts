/**
 * Status subscriptions contract (SP-status-04): a visitor subscribes to status updates by email, confirms by a signed
 * link, picks components and an optional webhook, and leaves by the signed link in every message.
 *
 * - Double opt-in: a subscriber is `unconfirmed` until the link in the confirmation message is opened, and nothing but
 *   that message is sent before then. Opening the link again changes nothing.
 * - Email leaves through an email sender the owner configures. With none, the confirmation is recorded as pending with
 *   `vendor.email` and the page says so. SMS and push are not offered: `vendor.sms`, `vendor.push`.
 * - Safeguards: a self-hosted proof-of-work challenge on the subscribe form (no third-party captcha), and a limit of
 *   subscribe requests per address per hour. Both are owner values, blank until set: a blank challenge strength or limit
 *   refuses subscribing (`status.challenge_unset`, `status.rate_limit_unset`).
 * - A webhook goes to the subscriber's own https endpoint; a private, loopback or link-local address is refused.
 *
 * Browser safe: the proof-of-work check uses only the hash the caller passes in.
 */
import { z } from 'zod';
import { statusComponentIdSchema } from './status-page.js';

export const STATUS_SUBSCRIPTION_ERROR_CODES = [
  'status.challenge_unset',
  'status.challenge_failed',
  'status.rate_limit_unset',
  'status.rate_limited',
  'status.webhook_target_refused',
  'status.subscriber_unknown',
  'status.subscription_link_invalid',
  'status.component_unknown',
] as const;
export type StatusSubscriptionErrorCode = (typeof STATUS_SUBSCRIPTION_ERROR_CODES)[number];

export const STATUS_SUBSCRIBER_STATES = ['unconfirmed', 'active', 'unsubscribed'] as const;
export type StatusSubscriberState = (typeof STATUS_SUBSCRIBER_STATES)[number];

/** Why a channel cannot be offered: the allowlisted not-connected code, or null when it works. */
export const STATUS_NOT_CONNECTED = ['vendor.email', 'vendor.sms', 'vendor.push'] as const;

export const STATUS_CHALLENGE_BITS_MAX = 32;
export const STATUS_SUBSCRIBE_RATE_MAX = 1000;

/** What the subscribe form needs before it is shown. */
export const statusSubscriptionPolicySchema = z
  .object({
    email: z.enum(STATUS_NOT_CONNECTED).nullable(),
    sms: z.literal('vendor.sms'),
    push: z.literal('vendor.push'),
    /** Leading zero bits the proof of work needs; null while the owner has not set it. */
    challengeBits: z.number().int().nullable(),
    rateLimitSet: z.boolean(),
  })
  .strict();
export type StatusSubscriptionPolicy = z.infer<typeof statusSubscriptionPolicySchema>;

/** A challenge to solve: find `nonce` so that sha256(`${token}:${nonce}`) starts with `bits` zero bits. */
export const statusChallengeSchema = z.object({ token: z.string().min(1).max(400), bits: z.number().int().min(1) }).strict();
export type StatusChallenge = z.infer<typeof statusChallengeSchema>;

const nonce = z.string().regex(/^[0-9a-z]{1,32}$/);
const email = z.string().trim().toLowerCase().email().max(254);

export const statusSubscribeInputSchema = z
  .object({
    email,
    /** null means every component, and notices that name none. */
    componentIds: z.array(statusComponentIdSchema).max(100).nullable(),
    challenge: z.object({ token: z.string().min(1).max(400), nonce }).strict(),
  })
  .strict();
export type StatusSubscribeInput = z.infer<typeof statusSubscribeInputSchema>;

/** What a subscribe request answers. The address is never echoed back, so the form cannot be used to look addresses up. */
export const statusSubscribeResultSchema = z
  .object({
    state: z.literal('confirmation_sent').or(z.literal('confirmation_pending')),
    /** Set when the confirmation could not leave: the allowlisted code. */
    notConnected: z.enum(STATUS_NOT_CONNECTED).nullable(),
  })
  .strict();
export type StatusSubscribeResult = z.infer<typeof statusSubscribeResultSchema>;

export const statusLinkInputSchema = z.object({ token: z.string().min(1).max(400) }).strict();

export const statusSubscriptionSchema = z
  .object({
    state: z.enum(STATUS_SUBSCRIBER_STATES),
    /** The address with its local part masked. */
    email: z.string(),
    componentIds: z.array(z.string()).nullable(),
    webhookUrl: z.string().nullable(),
  })
  .strict();
export type StatusSubscription = z.infer<typeof statusSubscriptionSchema>;

export const statusSubscriptionUpdateInputSchema = z
  .object({
    token: z.string().min(1).max(400),
    componentIds: z.array(statusComponentIdSchema).max(100).nullable(),
    webhookUrl: z.string().trim().url().max(500).nullable(),
  })
  .strict();
export type StatusSubscriptionUpdateInput = z.infer<typeof statusSubscriptionUpdateInputSchema>;

/** True when sha256 `digest` (raw bytes) starts with `bits` zero bits. */
export function statusChallengeMet(digest: Uint8Array, bits: number): boolean {
  let left = bits;
  for (const byte of digest) {
    if (left <= 0) return true;
    if (left >= 8) {
      if (byte !== 0) return false;
      left -= 8;
    } else return byte >> (8 - left) === 0;
  }
  return left <= 0;
}

/** The text a proof of work hashes. */
export const statusChallengeText = (token: string, nonce: string): string => `${token}:${nonce}`;
