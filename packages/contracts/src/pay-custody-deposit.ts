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
export const PAY_CUSTODY_DEPOSIT_RECORDS_PATH = '/internal/custody-deposits/records' as const;

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

/**
 * A pair the owner has switched off. It takes no new address and no new catalogue entry; `haltNote` is the owner's line for
 * customers (null means the standard "switched off" line only). A pair with no row at all is not listed: nothing is implied.
 */
export const payCustodyDepositHaltedSchema = z
  .object({
    assetId: assetIdSchema,
    networkId: networkIdSchema,
    label: z.string().min(1).max(64),
    haltNote: z.string().min(1).max(280).nullable(),
  })
  .strict();
export type PayCustodyDepositHalted = z.infer<typeof payCustodyDepositHaltedSchema>;

export const payCustodyDepositCatalogueSchema = z
  .object({
    entries: z.array(payCustodyDepositEntrySchema).max(500),
    /** Optional so an older svc-pay reply still parses; absent means none are known to be halted. */
    halted: z.array(payCustodyDepositHaltedSchema).max(500).optional(),
  })
  .strict();
export type PayCustodyDepositCatalogue = z.infer<typeof payCustodyDepositCatalogueSchema>;

/**
 * The highest address index svc-pay will derive for one person, asset and network. An index is never reused, so this bounds the
 * addresses ever made, expired ones included; how many may be open at once is the owner's cap, which svc-bank enforces.
 */
export const PAY_CUSTODY_DEPOSIT_MAX_ADDRESS_INDEX = 9999;

/**
 * Which address to issue (W-deposit-02). `addressIndex` absent or 0 is the person's first address for the pair, which never
 * expires. An extra address (index 1 and up) carries the `expiresAt` svc-bank computed from the owner's window; svc-pay stores
 * it with the address the first time and keeps the stored value on every later call. A deposit that first reaches an address
 * after its expiry is held for release, never credited on its own and never dropped.
 */
export const payCustodyDepositAddressInputSchema = z
  .object({
    /** Bank user ids are opaque text. */
    userId: z.string().min(1).max(128),
    assetId: assetIdSchema,
    networkId: networkIdSchema,
    addressIndex: z.number().int().min(0).max(PAY_CUSTODY_DEPOSIT_MAX_ADDRESS_INDEX).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const extra = (input.addressIndex ?? 0) > 0;
    if (extra && input.expiresAt === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'an extra address needs its expiry' });
    }
    if (!extra && input.expiresAt !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'the first address does not expire' });
    }
  });
export type PayCustodyDepositAddressInput = z.infer<typeof payCustodyDepositAddressInputSchema>;

/** An address with no whitespace, at most 256 characters. The memo and QR text are bounded the same way the bank stores them. */
export const payCustodyDepositAddressSchema = z
  .object({
    address: z.string().min(1).max(256).regex(/^\S+$/),
    memo: z.string().min(1).max(128).nullable(),
    qrPayload: z.string().min(1).max(512).nullable(),
    /** Present for an extra address only; absent means the first address (0), as every older reply is. */
    addressIndex: z.number().int().min(0).max(PAY_CUSTODY_DEPOSIT_MAX_ADDRESS_INDEX).optional(),
    /** The stored expiry of an extra address; absent or null never expires. */
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();
export type PayCustodyDepositAddress = z.infer<typeof payCustodyDepositAddressSchema>;

/**
 * Why svc-pay refused to issue: the pair is not in the catalogue, the chain port will not derive, or a new extra address was
 * asked for with an expiry that has already passed (it would only ever hold deposits for release).
 */
export const PAY_CUSTODY_DEPOSIT_REFUSALS = [
  'pay.deposit_pair_unpublished',
  'pay.deposit_source_unset',
  'pay.deposit_address_expiry_past',
] as const;
export type PayCustodyDepositRefusal = (typeof PAY_CUSTODY_DEPOSIT_REFUSALS)[number];

export const payCustodyDepositAddressReplySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('issued'), address: payCustodyDepositAddressSchema }).strict(),
  z.object({ state: z.literal('refused'), code: z.enum(PAY_CUSTODY_DEPOSIT_REFUSALS) }).strict(),
]);
export type PayCustodyDepositAddressReply = z.infer<typeof payCustodyDepositAddressReplySchema>;

/**
 * The states of a deposit record (W-deposit-05). `detected` and `confirming` are on the chain and not yet credited; `credited`
 * is the one state that posted a `deposit`. `below_minimum`, `rejected` and `needs_review` never credit on their own;
 * `held_for_screening` and `reversed` are written by the hold and reorg slice (W-deposit-06), and are listed here so a reader
 * never meets a state it cannot name. `held_for_release` (reason `address_expired`) is a deposit that first reached an extra
 * address after its expiry (W-deposit-02): never credited on its own, kept for a support or compliance release. `on_hold`
 * (reason `address_frozen`) is a deposit to an address compliance froze (W-compliance-notices-03): never credited while the
 * freeze stands, and judged again once a second founder unfreezes it.
 */
export const PAY_CUSTODY_DEPOSIT_STATUSES = [
  'detected',
  'confirming',
  'credited',
  'below_minimum',
  'held_for_screening',
  'held_for_release',
  'on_hold',
  'rejected',
  'reversed',
  'needs_review',
] as const;
export type PayCustodyDepositStatus = (typeof PAY_CUSTODY_DEPOSIT_STATUSES)[number];

/** The states that are still on their way: the pending list. */
export const PAY_CUSTODY_DEPOSIT_PENDING_STATUSES = ['detected', 'confirming'] as const satisfies readonly PayCustodyDepositStatus[];

/**
 * The reason a record is not credited, as a code the screen can say in words. Null while the record is on its way or credited.
 * `amount_mismatch` is a finalized amount that differs from the one first seen; `unknown_asset` is a token the address was not
 * issued for. `chain_reorg` is a credit reversed because the chain rewrote the block it was read from; `reversal_unfunded` is
 * a reversal the balance could not cover (the funds were already spent), left for a person to resolve. `address_expired` is a
 * deposit that first reached an extra address after its expiry (`held_for_release`). `address_frozen` is a deposit to an
 * address compliance froze (`on_hold`).
 */
export const PAY_CUSTODY_DEPOSIT_REASONS = [
  'below_minimum',
  'amount_mismatch',
  'unknown_asset',
  'minimum_unset',
  'confirmations_unset',
  'chain_reorg',
  'reversal_unfunded',
  'address_expired',
  'address_frozen',
] as const;
export type PayCustodyDepositReason = (typeof PAY_CUSTODY_DEPOSIT_REASONS)[number];

/** One deposit to one customer address. Unique on (assetId, networkId, txHash, outputIndex). */
export const payCustodyDepositRecordSchema = z
  .object({
    id: z.string().min(1).max(128),
    assetId: assetIdSchema,
    networkId: networkIdSchema,
    address: z.string().min(1).max(256).regex(/^\S+$/),
    txHash: z.string().min(1).max(128).regex(/^\S+$/),
    outputIndex: z.number().int().min(0).max(1_000_000),
    amount: decimalSchema,
    confirmations: z.number().int().min(0).max(1_000_000),
    /** Null when the network's count is blank: the record shows no target rather than an invented one. */
    confirmationsRequired: z.number().int().min(1).max(100_000).nullable(),
    status: z.enum(PAY_CUSTODY_DEPOSIT_STATUSES),
    reason: z.enum(PAY_CUSTODY_DEPOSIT_REASONS).nullable(),
    /** The minimum deposit in force when the record was judged. Null while it has not been judged. */
    minimumDeposit: decimalSchema.nullable(),
    detectedAt: z.string().datetime(),
    creditedAt: z.string().datetime().nullable(),
  })
  .strict();
export type PayCustodyDepositRecord = z.infer<typeof payCustodyDepositRecordSchema>;

/** The most records one call returns. A caller that needs more pages. */
export const PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT = 200;

export const payCustodyDepositRecordsInputSchema = z
  .object({
    userId: z.string().min(1).max(128),
    assetId: assetIdSchema.optional(),
    networkId: networkIdSchema.optional(),
    statuses: z.array(z.enum(PAY_CUSTODY_DEPOSIT_STATUSES)).min(1).max(PAY_CUSTODY_DEPOSIT_STATUSES.length).optional(),
    txHash: z.string().min(1).max(128).regex(/^\S+$/).optional(),
    address: z.string().min(1).max(256).regex(/^\S+$/).optional(),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    limit: z.number().int().min(1).max(PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT).default(50),
  })
  .strict();
export type PayCustodyDepositRecordsInput = z.input<typeof payCustodyDepositRecordsInputSchema>;

/** `total` counts every match, so a caller can tell a full page from the last one and never drops the rest silently. */
export const payCustodyDepositRecordsReplySchema = z
  .object({ items: z.array(payCustodyDepositRecordSchema).max(PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT), total: z.number().int().min(0) })
  .strict();
export type PayCustodyDepositRecordsReply = z.infer<typeof payCustodyDepositRecordsReplySchema>;

export type PayCustodyDepositCatalogueResult =
  { state: 'ok'; catalogue: PayCustodyDepositCatalogue } | { state: 'unavailable'; code: 'pay.custody_deposit_unavailable' };
export type PayCustodyDepositAddressResult =
  PayCustodyDepositAddressReply | { state: 'unavailable'; code: 'pay.custody_deposit_unavailable' };

export type PayCustodyDepositRecordsResult =
  { state: 'ok'; records: PayCustodyDepositRecordsReply } | { state: 'unavailable'; code: 'pay.custody_deposit_unavailable' };

/** What svc-bank holds. The HTTP client below is the only implementation outside tests. */
export interface PayCustodyDepositPort {
  catalogue(): Promise<PayCustodyDepositCatalogueResult>;
  address(input: PayCustodyDepositAddressInput): Promise<PayCustodyDepositAddressResult>;
  records(input: PayCustodyDepositRecordsInput): Promise<PayCustodyDepositRecordsResult>;
}
