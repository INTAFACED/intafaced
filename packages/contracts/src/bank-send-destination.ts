import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * May money be sent to this address now? Asked by svc-pay before it claims a withdrawal to a wallet outside the platform
 * (J-wallet-05 #6, issue #6517), answered by svc-bank, which owns the customer's address book (`ramps.destinations`: saved
 * per asset and network, approved by an emailed link or another device, then a cooling-off; W-withdraw-09). It is the first PR
 * of the two-PR order: svc-bank serves it, svc-pay asks it, and svc-pay never reads the address book tables.
 *
 * ONE QUESTION, NO WRITE. The answer is about one address of one asset on one network, for the person named:
 * - `ready`: an entry of that asset, network and address (no tag: a send carries none) is saved, approved and past its
 *   cooling-off, and the owner's security lock is open.
 * - `other_network`: the address is saved for that asset, but only on another network. Sending it on this one could lose it.
 * - `not_saved`: the address is not in the book for that asset at all.
 * - `locked`, `blocked`, `approval_pending`, `cooling_unset`, `cooling`: the entry is saved on that network and the address
 *   book's own readiness says why not now (`ramps.destinations.readiness`).
 *
 * The call carries no state change, but it is a POST to a tRPC mutation, the same shape as `business.approverEligibility`,
 * because the signed body is what the caller proves. A caller that cannot get an answer (no URL, no secret, a timeout, a
 * malformed reply) gets `unavailable` and must refuse the send: an address book that cannot be read is never read as "ready".
 */

/** The tRPC path on svc-bank's root router. */
export const BANK_SEND_DESTINATION_PROCEDURE = 'ramps.destinations.sendable' as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; the list is enforced under either S2S mode. */
export const BANK_SEND_DESTINATION_CALLERS: readonly ServiceName[] = ['svc-pay'];

export const bankSendDestinationInputSchema = z
  .object({
    /** The person sending. Bank user ids are opaque text. */
    userId: z.string().min(1).max(128),
    assetId: z.string().regex(/^[A-Za-z0-9]{1,16}$/),
    /** The network chosen for the send, as the address book names networks. */
    network: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/),
    /** The address the money goes to, as the person sent it. */
    ref: z.string().min(1).max(256),
  })
  .strict();
export type BankSendDestinationInput = z.infer<typeof bankSendDestinationInputSchema>;

export const BANK_SEND_DESTINATION_STATES = [
  'ready',
  'not_saved',
  'other_network',
  'locked',
  'blocked',
  'approval_pending',
  'cooling_unset',
  'cooling',
] as const;
export type BankSendDestinationState = (typeof BANK_SEND_DESTINATION_STATES)[number];

export const bankSendDestinationSchema = z
  .object({
    state: z.enum(BANK_SEND_DESTINATION_STATES),
    /** The saved entry the answer is about; null for `not_saved` and `other_network`. */
    destinationId: z.string().guid().nullable(),
    /** When a running cooling-off ends, for `cooling`; null otherwise or when it never ends. */
    coolingOffEndsAt: z.string().nullable(),
  })
  .strict();
export type BankSendDestination = z.infer<typeof bankSendDestinationSchema>;

/** What a caller sees when no answer came back. Never `ready`. */
export type BankSendDestinationResult =
  BankSendDestination | { readonly state: 'unavailable'; readonly code: 'bank.send_destination_unavailable' };

/** The port svc-pay depends on. The HTTP client implements it; tests inject a fake. */
export interface BankSendDestinationPort {
  check(input: BankSendDestinationInput): Promise<BankSendDestinationResult>;
}
