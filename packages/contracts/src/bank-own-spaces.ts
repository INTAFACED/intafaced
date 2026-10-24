import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Own spaces: which named spaces does this customer own? Asked by svc-tax and answered by svc-bank, which owns the spaces
 * table. It is the first PR of the two-PR order for own-account carry in the lot book (PF-cost-basis-02, ENGINE LB-6): svc-bank
 * serves it, svc-tax asks it, and svc-tax never reads the spaces table.
 *
 * A named space is a view over the ledger account `subAccountAvailable(spaceId, assetId)`; the primary space is the customer's
 * own `userAvailable` account, which the caller already knows, so it is not listed. Every named space the customer ever owned
 * is listed, archived ones too: a lot moved into a space that was later archived is still the customer's lot.
 *
 * ONE QUESTION, NO WRITE. No balance crosses: the ledger is the only source of what a space holds. The call is a POST to a tRPC
 * mutation, the same shape as `business.approverEligibility`, because the signed body is what the caller proves.
 *
 * A caller that cannot get an answer gets `unavailable` and must say so: an unreachable bank is never read as "no spaces".
 */

/** The tRPC path on svc-bank's root router. */
export const BANK_OWN_SPACES_PROCEDURE = 'spaces.ownedAccounts' as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; the list is enforced under either S2S mode. */
export const BANK_OWN_SPACES_CALLERS: readonly ServiceName[] = ['svc-tax'];

export const bankOwnSpacesInputSchema = z
  .object({
    /** The customer whose spaces are listed. Bank user ids are opaque text. */
    userId: z.string().min(1).max(128),
  })
  .strict();
export type BankOwnSpacesInput = z.infer<typeof bankOwnSpacesInputSchema>;

export const bankOwnSpaceSchema = z
  .object({
    /** The space id, which is also the `subaccount` owner id of its ledger account. */
    spaceId: z.string().guid(),
    assetId: z.string().min(1).max(16),
    name: z.string().min(1).max(64),
    archived: z.boolean(),
  })
  .strict();
export type BankOwnSpace = z.infer<typeof bankOwnSpaceSchema>;

export const bankOwnSpacesSchema = z.object({ spaces: z.array(bankOwnSpaceSchema) }).strict();
export type BankOwnSpaces = z.infer<typeof bankOwnSpacesSchema>;

/** What a caller sees: the list, or no answer. Never an empty list standing in for no answer. */
export type BankOwnSpacesResult =
  | { readonly state: 'read'; readonly spaces: readonly BankOwnSpace[] }
  | { readonly state: 'unavailable'; readonly code: 'bank.own_spaces_unavailable' };

/** The port svc-tax depends on. The HTTP client implements it; tests inject a fake. */
export interface BankOwnSpacesPort {
  list(input: BankOwnSpacesInput): Promise<BankOwnSpacesResult>;
}
