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

/**
 * The states of a deposit record (W-deposit-05). `detected` and `confirming` are on the chain and not yet credited; `credited`
 * is the one state that posted a `deposit`. `below_minimum`, `rejected` and `needs_review` never credit on their own;
 * `held_for_screening` and `reversed` are written by the hold and reorg slice (W-deposit-06), and are listed here so a reader
 * never meets a state it cannot name.
 */
export const PAY_CUSTODY_DEPOSIT_STATUSES = [
  'detected',
  'confirming',
  'credited',
  'below_minimum',
  'held_for_screening',
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
 * issued for.
 */
export const PAY_CUSTODY_DEPOSIT_REASONS = [
  'below_minimum',
  'amount_mismatch',
  'unknown_asset',
  'minimum_unset',
  'confirmations_unset',
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
