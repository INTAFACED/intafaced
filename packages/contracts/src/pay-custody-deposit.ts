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

/** The most unsupported cases one pair publishes, and the longest one; svc-pay's settings, its table and svc-bank use these. */
export const PAY_CUSTODY_DEPOSIT_UNSUPPORTED_MAX = 20;
export const PAY_CUSTODY_DEPOSIT_UNSUPPORTED_CASE_MAX = 280;

/** One case as it travels: written once, already trimmed, at most 280 characters. */
const unsupportedCaseSchema = z
  .string()
  .min(1)
  .max(PAY_CUSTODY_DEPOSIT_UNSUPPORTED_CASE_MAX)
  .refine((value) => value.trim() === value, 'an unsupported case is sent trimmed');

/**
 * One asset on one network that can take a deposit now. `memoRequired` is true for networks that route by memo or tag.
 * `sharedAddressGroup` names a group of assets that share one address on the network (for example every token on an EVM
 * chain); null means the address is the asset's own. `unsupported` is the owner's list of cases custody will not credit on this
 * network, shown before any address (W-deposit-03); absent means none was published.
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
    unsupported: z
      .array(unsupportedCaseSchema)
      .min(1)
      .max(PAY_CUSTODY_DEPOSIT_UNSUPPORTED_MAX)
      .refine((cases) => new Set(cases).size === cases.length, 'each unsupported case once')
      .optional(),
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
 * freeze stands, and judged again once a second founder unfreezes it. `held_travel_rule` is a deposit at or above the owner's
 * inbound travel-rule threshold (W-deposit-07): never credited while held, credited once after a founder releases it.
 */
export const PAY_CUSTODY_DEPOSIT_STATUSES = [
  'detected',
  'confirming',
  'credited',
  'below_minimum',
  'held_for_screening',
  'held_for_release',
  'on_hold',
  'held_travel_rule',
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
 * address compliance froze (`on_hold`). `travel_rule_unset` is a deposit that is otherwise due while the owner has set no
 * inbound travel rule for its asset (it stays `confirming`, never credited). The other `travel_rule_*` reasons say where a
 * `held_travel_rule` deposit stands: waiting for the depositor's declaration, under compliance review, waiting on the
 * counterparty, or past that wait (still held: a timer never releases).
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
  'travel_rule_unset',
  'travel_rule_declaration',
  'travel_rule_review',
  'travel_rule_counterparty',
  'travel_rule_expired',
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

// ── Open custody items: what custody received or lost that the ledger does not show (founder, OPS-reconciliation-02) ─────

/**
 * The statuses of a deposit custody received but the ledger has not credited: each is held until a rule or a person lets it
 * through, and posts nothing while held (`custody/deposits/book.ts`). A row that ever started a credit is never one of these.
 */
export const PAY_CUSTODY_DEPOSIT_HELD_STATUSES = [
  'below_minimum',
  'held_for_screening',
  'held_for_release',
  'on_hold',
  'held_travel_rule',
] as const satisfies readonly PayCustodyDepositStatus[];

/**
 * `held`: custody holds it, the ledger booked nothing, so custody shows more than the ledger (a positive item).
 * `reversal_unfunded`: the ledger credited it, the chain took it back, and the reversal could not be covered (the funds were
 * spent), so custody shows less than the ledger (a negative item).
 */
export const PAY_CUSTODY_OPEN_ITEM_KINDS = ['held', 'reversal_unfunded'] as const;
export type PayCustodyOpenItemKind = (typeof PAY_CUSTODY_OPEN_ITEM_KINDS)[number];

/** An exact decimal that may be negative: custody minus ledger. Never `-0`. */
const signedDecimalSchema = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,29})(\.\d{1,18})?$/)
  .refine((v) => !/^-0(\.0+)?$/.test(v), 'a zero is never negative');

export const payCustodyOpenItemSchema = z
  .object({
    depositId: z.string().min(1).max(128),
    kind: z.enum(PAY_CUSTODY_OPEN_ITEM_KINDS),
    userId: z.string().min(1).max(128),
    assetId: assetIdSchema,
    networkId: networkIdSchema,
    txHash: z.string().min(1).max(128).regex(/^\S+$/),
    outputIndex: z.number().int().min(0).max(1_000_000),
    amount: decimalSchema,
    /** Custody minus ledger for this item: the amount for `held`, its negative for `reversal_unfunded`. */
    signedAmount: signedDecimalSchema,
    status: z.enum(PAY_CUSTODY_DEPOSIT_STATUSES),
    reason: z.enum(PAY_CUSTODY_DEPOSIT_REASONS).nullable(),
    detectedAt: z.string().datetime(),
  })
  .strict();
export type PayCustodyOpenItem = z.infer<typeof payCustodyOpenItemSchema>;

/** Per network and asset, over every open item that matches, not only the page. */
export const payCustodyOpenItemSumSchema = z
  .object({
    networkId: networkIdSchema,
    assetId: assetIdSchema,
    held: decimalSchema,
    heldCount: z.number().int().min(0),
    reversalUnfunded: decimalSchema,
    reversalUnfundedCount: z.number().int().min(0),
    /** `held` minus `reversalUnfunded`. */
    net: signedDecimalSchema,
  })
  .strict();
export type PayCustodyOpenItemSum = z.infer<typeof payCustodyOpenItemSumSchema>;

export const payCustodyOpenItemsInputSchema = z
  .object({
    networkId: networkIdSchema.optional(),
    assetId: assetIdSchema.optional(),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    limit: z.number().int().min(1).max(PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT).default(50),
  })
  .strict();
export type PayCustodyOpenItemsInput = z.input<typeof payCustodyOpenItemsInputSchema>;

/** `total` counts every match; `sums` cover every match, so a caller never adds up pages to get them. */
export const payCustodyOpenItemsReplySchema = z
  .object({
    items: z.array(payCustodyOpenItemSchema).max(PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT),
    total: z.number().int().min(0),
    sums: z.array(payCustodyOpenItemSumSchema),
  })
  .strict();
export type PayCustodyOpenItemsReply = z.infer<typeof payCustodyOpenItemsReplySchema>;

// ── Inbound travel rule on a deposit (W-deposit-07, W-compliance-notices-05) ───────────────────────────────────────────────

/** Where a deposit held for the travel rule stands. `released` is the one state that lets it be credited. */
export const PAY_DEPOSIT_TRAVEL_RULE_STATES = [
  'awaiting_declaration',
  'under_review',
  'counterparty_pending',
  'blocking_time_expired',
  'released',
] as const;
export type PayDepositTravelRuleState = (typeof PAY_DEPOSIT_TRAVEL_RULE_STATES)[number];

/** The IVMS101-shaped fields an owner can ask for (the same list as the outbound rule). */
export const PAY_TRAVEL_RULE_FIELDS = [
  'originator_name',
  'originator_address',
  'originator_date_of_birth',
  'originator_national_identifier',
  'beneficiary_name',
  'beneficiary_address',
  'beneficiary_account',
  'beneficiary_institution',
  'beneficiary_wallet_type',
  'transfer_purpose',
  'self_or_third_party',
] as const;
export type PayTravelRuleField = (typeof PAY_TRAVEL_RULE_FIELDS)[number];

/** Where the money came from: another exchange (a VASP) or a wallet the sender holds the keys to. */
export const PAY_DEPOSIT_WALLET_TYPES = ['exchange', 'self_hosted'] as const;
export type PayDepositWalletType = (typeof PAY_DEPOSIT_WALLET_TYPES)[number];

/** The depositor's own view of one held deposit: what to declare and where it stands. No declared value is ever sent back. */
export const payDepositTravelRuleViewSchema = z
  .object({
    depositId: z.string().uuid(),
    assetId: assetIdSchema,
    networkId: networkIdSchema,
    amount: decimalSchema,
    threshold: decimalSchema,
    state: z.enum(PAY_DEPOSIT_TRAVEL_RULE_STATES),
    requiredFields: z.array(z.enum(PAY_TRAVEL_RULE_FIELDS)),
    walletType: z.enum(PAY_DEPOSIT_WALLET_TYPES).nullable(),
    declaredAt: z.string().datetime().nullable(),
    /** Set while compliance waits on the counterparty: when that wait runs out. Past it the deposit stays held. */
    waitDeadline: z.string().datetime().nullable(),
  })
  .strict();
export type PayDepositTravelRuleView = z.infer<typeof payDepositTravelRuleViewSchema>;

export const payDepositTravelRuleGetInputSchema = z.object({ depositId: z.string().uuid() }).strict();
export type PayDepositTravelRuleGetInput = z.infer<typeof payDepositTravelRuleGetInputSchema>;

/** One declared value. Free text the depositor types; svc-pay seals it and never returns it. */
const declaredValueSchema = z.string().trim().min(1).max(500);

export const payDepositTravelRuleDeclareInputSchema = z
  .object({
    depositId: z.string().uuid(),
    walletType: z.enum(PAY_DEPOSIT_WALLET_TYPES),
    fields: z.partialRecord(z.enum(PAY_TRAVEL_RULE_FIELDS), declaredValueSchema),
  })
  .strict();
export type PayDepositTravelRuleDeclareInput = z.infer<typeof payDepositTravelRuleDeclareInputSchema>;
