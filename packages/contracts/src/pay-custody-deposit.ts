import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Customer crypto deposits, the svc-bank to svc-pay seam (W-deposit-01). svc-pay owns the chain port and the registries, so
 * it alone says which asset and network pairs can take a deposit and which address belongs to a person. svc-bank asks over
 * two signed internal POSTs and keeps its own per-user address row; neither service reads the other's tables, and svc-bank
 * derives no key.
 *
 * NOTHING IS INVENTED. A network whose confirmation count or minimum deposit is blank is left out of the catalogue. A caller
 * that cannot get an answer (no URL, no secret, a timeout, a malformed reply) gets `unavailable`, which the bank turns into
 * `bank.deposit_custody_unset`; it never shows an address it did not receive.
 */

/** The internal paths on svc-pay. */
export const PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH = '/internal/custody-deposits/catalogue' as const;
export const PAY_CUSTODY_DEPOSIT_ADDRESS_PATH = '/internal/custody-deposits/address' as const;

/** The only service allowed to call either path. */
export const PAY_CUSTODY_DEPOSIT_CALLERS: readonly ServiceName[] = ['svc-bank'];

const assetIdSchema = z.string().regex(/^[A-Za-z0-9]{1,16}$/);
const networkIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
/** An exact decimal string: no sign, no exponent, at most 18 places. */
const decimalSchema = z.string().regex(/^(0|[1-9]\d{0,29})(\.\d{1,18})?$/);

/**
 * One asset on one network that can take a deposit now. `memoRequired` is true for networks that route by memo or tag.
 * `sharedAddressGroup` names a group of assets that share one address on the network (for example every token on an EVM
 * chain); null means the address is the asset's own.
 */
export const payCustodyDepositEntrySchema = z
  .object({
    assetId: assetIdSchema,
    networkId: networkIdSchema,
    label: z.string().min(1).max(64),
    minimumDeposit: decimalSchema,
    confirmationsRequired: z.number().int().min(1).max(100_000),
    estimatedArrivalMinutes: z.number().int().min(1).max(100_000),
    memoRequired: z.boolean(),
    sharedAddressGroup: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type PayCustodyDepositEntry = z.infer<typeof payCustodyDepositEntrySchema>;

export const payCustodyDepositCatalogueSchema = z.object({ entries: z.array(payCustodyDepositEntrySchema).max(500) }).strict();
export type PayCustodyDepositCatalogue = z.infer<typeof payCustodyDepositCatalogueSchema>;

export const payCustodyDepositAddressInputSchema = z
  .object({
    /** Bank user ids are opaque text. */
    userId: z.string().min(1).max(128),
    assetId: assetIdSchema,
    networkId: networkIdSchema,
  })
  .strict();
export type PayCustodyDepositAddressInput = z.infer<typeof payCustodyDepositAddressInputSchema>;

/** An address with no whitespace, at most 256 characters. The memo and QR text are bounded the same way the bank stores them. */
export const payCustodyDepositAddressSchema = z
  .object({
    address: z.string().min(1).max(256).regex(/^\S+$/),
    memo: z.string().min(1).max(128).nullable(),
    qrPayload: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type PayCustodyDepositAddress = z.infer<typeof payCustodyDepositAddressSchema>;

/** Why svc-pay refused to issue: the pair is not in the catalogue, or the chain port will not derive. */
export const PAY_CUSTODY_DEPOSIT_REFUSALS = ['pay.deposit_pair_unpublished', 'pay.deposit_source_unset'] as const;
export type PayCustodyDepositRefusal = (typeof PAY_CUSTODY_DEPOSIT_REFUSALS)[number];

export const payCustodyDepositAddressReplySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('issued'), address: payCustodyDepositAddressSchema }).strict(),
  z.object({ state: z.literal('refused'), code: z.enum(PAY_CUSTODY_DEPOSIT_REFUSALS) }).strict(),
]);
export type PayCustodyDepositAddressReply = z.infer<typeof payCustodyDepositAddressReplySchema>;

export type PayCustodyDepositCatalogueResult =
  { state: 'ok'; catalogue: PayCustodyDepositCatalogue } | { state: 'unavailable'; code: 'pay.custody_deposit_unavailable' };
export type PayCustodyDepositAddressResult =
  PayCustodyDepositAddressReply | { state: 'unavailable'; code: 'pay.custody_deposit_unavailable' };

/** What svc-bank holds. The HTTP client below is the only implementation outside tests. */
export interface PayCustodyDepositPort {
  catalogue(): Promise<PayCustodyDepositCatalogueResult>;
  address(input: PayCustodyDepositAddressInput): Promise<PayCustodyDepositAddressResult>;
}
