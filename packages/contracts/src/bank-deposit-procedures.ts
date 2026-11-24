import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import {
  PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT,
  PAY_CUSTODY_DEPOSIT_STATUSES,
  payCustodyDepositRecordSchema,
} from './pay-custody-deposit.js';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-bank `deposits.*` the customer calls: crypto deposits, one record per call. The catalogue, the addresses and the
 * incoming rows are custody's; nothing here moves money. svc-bank mounts each from here (`router.ts`) and the customer
 * app calls each by its record (`features/money/deposit-reads.ts`).
 */

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
const assetIdField = z.string().min(1).max(16);
const networkIdField = z.string().min(1).max(32);

/** What custody says can be paid in on one network. Every number is the service's own decimal or count. */
export const bankDepositNetworkSchema = z.object({
  id: z.string(),
  label: z.string(),
  minimumDeposit: amount,
  confirmationsRequired: z.number().int().nonnegative(),
  estimatedArrivalMinutes: z.number().int().nonnegative(),
  /** The owner's notes on this network, shown as written; absent when none was published. */
  requirements: z.array(z.string().min(1)).optional(),
  /** The owner's cases custody will not credit on this network; absent when none was published. */
  unsupported: z.array(z.string().min(1)).optional(),
  warnings: z.array(z.string().min(1)).optional(),
});
export type BankDepositNetwork = z.output<typeof bankDepositNetworkSchema>;

/**
 * A pair switched off, with the owner's note (null: the standard line only). It takes no address. `blockedBy: 'registry'`
 * marks a pair the supported asset list does not allow, with the asset's state there (null: the list does not publish it).
 */
export const bankDepositHaltedSchema = z.object({
  assetId: assetIdSchema,
  networkId: z.string(),
  label: z.string(),
  haltNote: z.string().nullable(),
  blockedBy: z.literal('registry').optional(),
  /** The registry's own states (`ASSET_STATES` in `asset-registry.ts`, not imported: it is not browser-safe). */
  assetState: z.enum(['active', 'halted', 'retired']).nullable().optional(),
});
export type BankDepositHalted = z.output<typeof bankDepositHaltedSchema>;

export const bankDepositCatalogueSchema = z.object({
  assets: z.array(
    z.object({
      assetId: assetIdSchema,
      /**
       * The asset's decimal places in the supported asset list (`assets.list`), the same for Deposit and Withdraw. svc-bank
       * always sends it; a caller shows none when it is absent.
       */
      precision: z.number().int().nonnegative().optional(),
      networks: z.array(bankDepositNetworkSchema),
    }),
  ),
  /** svc-bank always sends it; absent reads as none switched off. */
  halted: z.array(bankDepositHaltedSchema).optional(),
});
export type BankDepositCatalogue = z.output<typeof bankDepositCatalogueSchema>;

export const bankDepositAddressSchema = z.object({
  assetId: assetIdSchema,
  networkId: z.string(),
  address: z.string(),
  memo: z.string().nullable(),
  qrPayload: z.string().nullable(),
});
export type BankDepositAddress = z.output<typeof bankDepositAddressSchema>;

/** One deposit address as the address list shows it: the first (number 0, never expires) or an extra one. */
export const bankDepositAddressItemSchema = z.object({
  assetId: assetIdSchema,
  networkId: z.string(),
  addressIndex: z.number().int().nonnegative(),
  address: z.string(),
  memo: z.string().nullable(),
  qrPayload: z.string().nullable(),
  label: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  state: z.enum(['active', 'expired']),
});
export type BankDepositAddressItem = z.output<typeof bankDepositAddressItemSchema>;

export const bankDepositAddressListSchema = z.object({
  items: z.array(bankDepositAddressItemSchema),
  cap: z.number().int().positive().nullable(),
  expiryDays: z.number().int().positive().nullable(),
});
export type BankDepositAddressList = z.output<typeof bankDepositAddressListSchema>;

export const bankDepositPendingSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      assetId: assetIdSchema,
      networkId: z.string(),
      amount,
      confirmations: z.number().int().nonnegative(),
      confirmationsRequired: z.number().int().nonnegative().nullable(),
    }),
  ),
});
export type BankDepositPending = z.output<typeof bankDepositPendingSchema>;

export const bankDepositRecordsSchema = z.object({
  items: z.array(payCustodyDepositRecordSchema),
  total: z.number().int().nonnegative(),
});
export type BankDepositRecords = z.output<typeof bankDepositRecordsSchema>;

/** The status each refusal is sent with: svc-bank's `deposits/bank-errors.ts` and `shared-bank-errors.ts`. */
const STATUS = {
  'bank.deposit_custody_unset': 'PRECONDITION_FAILED',
  'bank.deposit_catalogue_invalid': 'PRECONDITION_FAILED',
  'bank.deposit_asset_unpublished': 'PRECONDITION_FAILED',
  'bank.deposit_network_halted': 'PRECONDITION_FAILED',
  'bank.deposit_pending_unbounded': 'PRECONDITION_FAILED',
  'bank.deposit_address_cap_unset': 'PRECONDITION_FAILED',
  'bank.deposit_address_expiry_unset': 'PRECONDITION_FAILED',
  'bank.deposit_address_cap_reached': 'PRECONDITION_FAILED',
  'bank.deposit_address_numbers_used': 'PRECONDITION_FAILED',
  'bank.deposit_address_not_found': 'NOT_FOUND',
  'bank.deposit_address_label_invalid': 'BAD_REQUEST',
  'bank.asset_registry_unavailable': 'SERVICE_UNAVAILABLE',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

/** What reading the catalogue together with the supported asset list refuses. */
const CATALOGUE = ['bank.deposit_custody_unset', 'bank.deposit_catalogue_invalid', 'bank.asset_registry_unavailable'] as const;
/** What a pair that must take an address refuses, beyond the catalogue read. */
const OPEN_PAIR = [...CATALOGUE, 'bank.deposit_network_halted', 'bank.deposit_asset_unpublished'] as const;

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'bank:read', module: 'bank' } as const;
const WRITE = { caller: 'scope', scope: 'bank:write', module: 'bank' } as const;

/** Assets custody says can be paid in, and the pairs switched off. A blank port refuses `bank.deposit_custody_unset`. */
export const BANK_DEPOSITS_ASSETS = defineProcedure({
  ...base,
  name: 'bank.deposits.assets',
  kind: 'query',
  path: 'deposits.assets',
  access: READ,
  refusals: refuse(...CATALOGUE),
  input: NO_INPUT,
  output: bankDepositCatalogueSchema,
  samples: [{ verdict: 'accept' }],
});

/** The person's own first address for one asset on one network: the same call returns the same address. */
export const BANK_DEPOSITS_ADDRESS = defineProcedure({
  ...base,
  name: 'bank.deposits.address',
  kind: 'mutation',
  path: 'deposits.address',
  access: WRITE,
  refusals: refuse(...OPEN_PAIR),
  input: z.object({ assetId: assetIdField, networkId: networkIdField }),
  output: bankDepositAddressSchema,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', networkId: 'ethereum' } },
    { verdict: 'refuse', input: { assetId: '', networkId: 'ethereum' } },
    { verdict: 'refuse', input: { assetId: 'USDC' } },
  ],
});

/** The person's deposit addresses, the first and every extra one, expired ones included, with the owner's cap and expiry. */
export const BANK_DEPOSITS_ADDRESSES_LIST = defineProcedure({
  ...base,
  name: 'bank.deposits.addresses.list',
  kind: 'query',
  path: 'deposits.addresses.list',
  access: READ,
  refusals: refuse(),
  input: z.object({ assetId: assetIdField.optional(), networkId: networkIdField.optional() }).strict().default({}),
  output: bankDepositAddressListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'accept', input: { assetId: 'USDC', networkId: 'ethereum' } },
    { verdict: 'refuse', input: { assetId: 'USDC', other: 1 } },
  ],
});

/** One more address for this asset and network, with an optional label. Blank cap or expiry window refuses. */
export const BANK_DEPOSITS_ADDRESSES_CREATE = defineProcedure({
  ...base,
  name: 'bank.deposits.addresses.create',
  kind: 'mutation',
  path: 'deposits.addresses.create',
  access: WRITE,
  refusals: refuse(
    ...OPEN_PAIR,
    'bank.deposit_address_label_invalid',
    'bank.deposit_address_cap_unset',
    'bank.deposit_address_expiry_unset',
    'bank.deposit_address_cap_reached',
    'bank.deposit_address_numbers_used',
  ),
  input: z.object({ assetId: assetIdField, networkId: networkIdField, label: z.string().max(80).nullable().optional() }).strict(),
  output: bankDepositAddressItemSchema,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', networkId: 'ethereum' } },
    { verdict: 'accept', input: { assetId: 'USDC', networkId: 'ethereum', label: 'Savings' } },
    { verdict: 'refuse', input: { assetId: 'USDC', networkId: 'ethereum', label: 'x'.repeat(81) } },
  ],
});

/** Set or clear (empty or null) one address's label. The same label twice is one change. */
export const BANK_DEPOSITS_ADDRESSES_LABEL = defineProcedure({
  ...base,
  name: 'bank.deposits.addresses.label',
  kind: 'mutation',
  path: 'deposits.addresses.label',
  access: WRITE,
  refusals: refuse('bank.deposit_address_label_invalid', 'bank.deposit_address_not_found'),
  input: z
    .object({
      assetId: assetIdField,
      networkId: networkIdField,
      addressIndex: z.number().int().min(0).max(9999),
      label: z.string().max(80).nullable(),
    })
    .strict(),
  output: bankDepositAddressItemSchema,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', networkId: 'ethereum', addressIndex: 1, label: 'Savings' } },
    { verdict: 'accept', input: { assetId: 'USDC', networkId: 'ethereum', addressIndex: 0, label: null } },
    { verdict: 'refuse', input: { assetId: 'USDC', networkId: 'ethereum', addressIndex: 10_000, label: null } },
  ],
});

/** Incoming deposits custody is still confirming. An empty list means custody is connected and nothing is incoming. */
export const BANK_DEPOSITS_PENDING = defineProcedure({
  ...base,
  name: 'bank.deposits.pending',
  kind: 'query',
  path: 'deposits.pending',
  access: READ,
  refusals: refuse('bank.deposit_custody_unset', 'bank.deposit_pending_unbounded', 'bank.deposit_catalogue_invalid'),
  input: NO_INPUT,
  output: bankDepositPendingSchema,
  samples: [{ verdict: 'accept' }],
});

/** The customer's own deposit history with its state and reason, filtered, a page with the true total. */
export const BANK_DEPOSITS_LIST = defineProcedure({
  ...base,
  name: 'bank.deposits.list',
  kind: 'query',
  path: 'deposits.list',
  access: READ,
  refusals: refuse('bank.deposit_custody_unset'),
  input: z
    .object({
      assetId: assetIdField.optional(),
      networkId: networkIdField.optional(),
      status: z.enum(PAY_CUSTODY_DEPOSIT_STATUSES).optional(),
      txId: z.string().min(1).max(128).optional(),
      address: z.string().min(1).max(256).optional(),
      offset: z.number().int().min(0).max(1_000_000).default(0),
      limit: z.number().int().min(1).max(PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT).default(50),
    })
    // An absent input is the first page: zod returns a root default unparsed, so it carries the fields' own defaults.
    .default({ offset: 0, limit: 50 }),
  output: bankDepositRecordsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'accept', input: { assetId: 'USDC', status: 'credited', limit: 20 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});
