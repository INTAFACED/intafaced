/**
 * What svc-bank answers the customer's money rooms (module `bank`): the deposit catalogue, addresses, pending deposits and
 * records (`deposits.*`), the supported asset list (`assets.list`), the money held in no named space (`spaces.unnamed`), a
 * transfer's reply (`transfers.create`, `transfers.toUser`) and the personal bank account's onboarding, requests, reviews,
 * closure and data requests (`bankAccount.*`). Browser-safe (zod only). A check against the caller's own request (the pair
 * asked for, the amount reviewed) stays in the app.
 */
import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { PAY_CUSTODY_DEPOSIT_REASONS, PAY_CUSTODY_DEPOSIT_STATUSES } from './pay-custody-deposit.js';
import { unsignedAmountSchema } from './wire-amount.js';

const decimal = unsignedAmountSchema;

// ── Deposits ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What custody says can be paid in. Every number is the service's own decimal or count. */
export const bankDepositNetworkSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  minimumDeposit: decimal,
  confirmationsRequired: z.number().int().nonnegative(),
  estimatedArrivalMinutes: z.number().int().nonnegative(),
  /**
   * What the service says about this network, shown as it was written. Each list may be absent or empty: nothing is made up for a
   * network that publishes none, and the standard wrong-network line is the only note then.
   */
  requirements: z.array(z.string().min(1)).optional(),
  unsupported: z.array(z.string().min(1)).optional(),
  warnings: z.array(z.string().min(1)).optional(),
});

/**
 * A pair switched off: listed so the person sees why, never given an address. `haltNote` is the owner's line, as written.
 * `blockedBy: 'registry'` is a pair the supported asset list does not allow, with the asset's state there (null: not listed).
 */
export const bankDepositHaltedSchema = z.object({
  assetId: assetIdSchema.min(1),
  networkId: z.string().min(1),
  label: z.string().min(1),
  haltNote: z.string().min(1).nullable(),
  blockedBy: z.literal('registry').optional(),
  assetState: z.enum(['active', 'halted', 'retired']).nullable().optional(),
});

/** `deposits.assets`. */
export const bankDepositCatalogueSchema = z.object({
  assets: z.array(
    z.object({
      assetId: assetIdSchema.min(1),
      /** The asset's decimal places in the supported asset list. Absent from an older bank: not shown. */
      precision: z.number().int().nonnegative().optional(),
      networks: z.array(bankDepositNetworkSchema),
    }),
  ),
  /** Absent from an older bank: none are known to be switched off. */
  halted: z.array(bankDepositHaltedSchema).optional(),
});

/** `deposits.address`: the person's own address for one asset on one network. */
export const bankDepositAddressSchema = z.object({
  assetId: assetIdSchema.min(1),
  networkId: z.string().min(1),
  address: z.string().min(1),
  memo: z.string().nullable(),
  qrPayload: z.string().nullable(),
});

/** One of the person's deposit addresses (`deposits.addresses.create`, `.label`): the first (number 0, never expires) or an extra one. */
export const bankDepositAddressItemSchema = z.object({
  assetId: assetIdSchema.min(1),
  networkId: z.string().min(1),
  addressIndex: z.number().int().nonnegative(),
  address: z.string().min(1),
  memo: z.string().nullable(),
  qrPayload: z.string().nullable(),
  label: z.string().min(1).nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  state: z.enum(['active', 'expired']),
});

/** `deposits.addresses.list`: the address list, with the founders' cap and expiry window, null while they are not set. */
export const bankDepositAddressListSchema = z.object({
  items: z.array(bankDepositAddressItemSchema),
  cap: z.number().int().positive().nullable(),
  expiryDays: z.number().int().positive().nullable(),
});

/** `deposits.pending`. */
export const bankDepositPendingSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      assetId: assetIdSchema.min(1),
      networkId: z.string().min(1),
      amount: decimal,
      confirmations: z.number().int().nonnegative(),
      confirmationsRequired: z.number().int().nonnegative().nullable(),
    }),
  ),
});

/** One row of `deposits.list`, in svc-pay's own states and reasons. */
export const bankDepositRecordSchema = z.object({
  id: z.string().min(1),
  assetId: assetIdSchema.min(1),
  networkId: z.string().min(1),
  address: z.string().min(1),
  txHash: z.string().min(1),
  outputIndex: z.number().int().nonnegative(),
  amount: decimal,
  confirmations: z.number().int().nonnegative(),
  confirmationsRequired: z.number().int().positive().nullable(),
  status: z.enum(PAY_CUSTODY_DEPOSIT_STATUSES),
  reason: z.enum(PAY_CUSTODY_DEPOSIT_REASONS).nullable(),
  minimumDeposit: decimal.nullable(),
  detectedAt: z.string(),
  creditedAt: z.string().nullable(),
});

/** `deposits.list`: a page, with the true total. */
export const bankDepositRecordsSchema = z.object({ items: z.array(bankDepositRecordSchema), total: z.number().int().nonnegative() });

// ── Supported assets ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Mirrors the registry's own enums (`ASSET_ACTIONS`, `ASSET_STATES`, `REGISTRY_ASSET_KINDS` in `asset-registry.ts`). */
export const BANK_SUPPORTED_ASSET_ACTIONS = ['deposit', 'withdraw', 'trade', 'transfer'] as const;
export const BANK_SUPPORTED_ASSET_STATES = ['active', 'halted', 'retired'] as const;

/** One row of svc-ledger's supported asset and network list, every state, as svc-bank hands it on (`assets.list`). */
export const bankSupportedAssetSchema = z.object({
  assetId: assetIdSchema.regex(/^[A-Z0-9]{1,16}$/),
  kind: z.enum(['crypto', 'fiat', 'native', 'commodity']),
  precision: z.number().int().min(0).max(18),
  networks: z.array(
    z.object({
      networkId: z.string().min(1),
      label: z.string().min(1),
      /** The contract on this network, or null when the registry knows none (a native coin, or not published). */
      contract: z.string().min(1).nullable().default(null),
      links: z.array(z.object({ label: z.string().min(1), url: z.string().regex(/^https:\/\//) })).default([]),
    }),
  ),
  defaultNetworkId: z.string().min(1).nullable(),
  allowedActions: z.array(z.enum(BANK_SUPPORTED_ASSET_ACTIONS)),
  state: z.enum(BANK_SUPPORTED_ASSET_STATES),
});

/** `assets.list`. */
export const bankSupportedAssetsSchema = z.object({ assets: z.array(bankSupportedAssetSchema) });

// ── Spaces and transfers ────────────────────────────────────────────────────────────────────────────────────────────────

/** `spaces.unnamed`: money of the person's held in no named space, per asset. */
export const bankUnnamedBalancesSchema = z.array(z.object({ assetId: assetIdSchema, balance: decimal }));

/**
 * `transfers.create` and `transfers.toUser`. A move the partner bank holds the money for, between the person's own spaces or
 * to another person, is one partner move and posts nothing to the ledger: its reply names the partner's move and no ledger
 * transaction. The app checks the amount and the echoed note and reference against what was reviewed.
 */
export const bankTransferReplySchema = z.object({
  ledgerTxId: z.string().min(1).nullable(),
  partnerMove: z
    .object({ id: z.string().min(1), label: z.string().min(1), movedAt: z.string().optional() })
    .nullable()
    .optional(),
  amount: decimal,
  note: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
});

// ── The personal bank account (`bankAccount.*`) ────────────────────────────────────────────────────────────────────────

const iso = z.string();

/** `bankAccount.onboarding`. */
export const bankAccountOnboardingSchema = z.object({
  label: z.string(),
  steps: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['done', 'open']), doneWith: z.string().nullable() })),
  requirements: z.array(z.string()),
  ownerRequirements: z.union([
    z.object({ state: z.literal('published'), requirements: z.array(z.string()) }),
    z.object({ state: z.literal('unset'), code: z.string() }),
  ]),
  identityCase: z.object({ tier: z.string(), accepted: z.boolean() }),
  complete: z.boolean(),
  openRequests: z.number(),
  openReviews: z.number(),
});

/** One document request (`bankAccount.answerRequest`). */
export const bankAccountRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  openedAt: iso,
  dueAt: iso,
  status: z.enum(['open', 'under_review']),
  answeredAt: iso.nullable(),
  file: z.object({ name: z.string(), type: z.string(), size: z.number(), sha256: z.string() }).nullable(),
  label: z.string(),
});

/** `bankAccount.requests`. */
export const bankAccountRequestsSchema = z.object({
  requests: z.array(bankAccountRequestSchema),
  upload: z.union([
    z.object({ state: z.literal('published'), allowedTypes: z.array(z.string()), maxBytes: z.number() }),
    z.object({ state: z.literal('unset'), code: z.string() }),
  ]),
});

/** One periodic review (`bankAccount.answerReview`). */
export const bankAccountReviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueAt: iso,
  missedEffect: z.string(),
  status: z.enum(['open', 'answered']),
  answeredAt: iso.nullable(),
  label: z.string(),
});

/** `bankAccount.reviews`. */
export const bankAccountReviewsSchema = z.object({ reviews: z.array(bankAccountReviewSchema) });

/** One closure (`bankAccount.requestClosure`, `bankAccount.reopen`). */
export const bankAccountClosureRowSchema = z.object({
  id: z.string(),
  state: z.enum(['pending', 'closed', 'reopened']),
  requestedAt: iso,
  balances: z.array(z.object({ assetId: assetIdSchema, spaceId: z.string().nullable(), amount: z.string() })),
  destination: z.object({ name: z.string(), accountRef: z.string() }).nullable(),
  payoutMoveIds: z.array(z.string()),
  paidOutAt: iso.nullable(),
  closedAt: iso.nullable(),
  reopenedAt: iso.nullable(),
  label: z.string(),
});

/** `bankAccount.closure`. */
export const bankAccountClosureSchema = z.object({
  state: z.enum(['open', 'pending', 'closed']),
  closures: z.array(bankAccountClosureRowSchema),
  reopenWindow: z.union([
    z.object({ state: z.literal('published'), days: z.number(), until: iso.nullable() }),
    z.object({ state: z.literal('unset'), code: z.string() }),
  ]),
});

/** One data request (`bankAccount.requestData`). */
export const bankAccountDataRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['access', 'portability']),
  requestedAt: iso,
  status: z.literal('received'),
  partnerRef: z.string(),
  label: z.string(),
});

/** `bankAccount.dataRequests`. */
export const bankAccountDataSchema = z.object({ requests: z.array(bankAccountDataRowSchema) });
