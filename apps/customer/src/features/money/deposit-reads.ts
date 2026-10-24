// hand-declared-ok: svc-bank's `bank.deposits.assets`, `bank.deposits.address` and `bank.deposits.addresses.*` outputs are declared inline in its router, not in a browser-safe @intafaced/contracts export; moving them there is a contracts follow-up.
import { z } from 'zod';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { decimalSchema } from '../../shared/money';
import type { ApiClient, ApiResult } from '../../shared/api';

/** What custody says can be paid in. Every number is the service's own decimal or count; nothing here is typed by hand. */
export const depositNetworkSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  minimumDeposit: decimalSchema,
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
export type DepositNetworkView = z.infer<typeof depositNetworkSchema>;

/**
 * A pair switched off: listed so the person sees why, never given an address. `haltNote` is the owner's line, as written.
 * `blockedBy: 'registry'` is a pair the supported asset list does not allow, with the asset's state there (null: not listed).
 */
export const depositHaltedSchema = z.object({
  assetId: z.string().min(1),
  networkId: z.string().min(1),
  label: z.string().min(1),
  haltNote: z.string().min(1).nullable(),
  blockedBy: z.literal('registry').optional(),
  assetState: z.enum(['active', 'halted', 'retired']).nullable().optional(),
});
export type DepositHaltedView = z.infer<typeof depositHaltedSchema>;

export const depositCatalogueSchema = z.object({
  assets: z.array(z.object({ assetId: z.string().min(1), networks: z.array(depositNetworkSchema) })),
  /** Absent from an older bank: none are known to be switched off. */
  halted: z.array(depositHaltedSchema).optional(),
});
export type DepositCatalogue = z.infer<typeof depositCatalogueSchema>;

export const depositAddressSchema = z.object({
  assetId: z.string().min(1),
  networkId: z.string().min(1),
  address: z.string().min(1),
  memo: z.string().nullable(),
  qrPayload: z.string().nullable(),
});
export type DepositAddressView = z.infer<typeof depositAddressSchema>;

/** One of the person's deposit addresses (W-deposit-02): the first (number 0, never expires) or an extra one. */
export const depositAddressItemSchema = z.object({
  assetId: z.string().min(1),
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
export type DepositAddressItem = z.infer<typeof depositAddressItemSchema>;

/** The address list, with the founders' cap and expiry window, null while they are not set. */
export const depositAddressListSchema = z.object({
  items: z.array(depositAddressItemSchema),
  cap: z.number().int().positive().nullable(),
  expiryDays: z.number().int().positive().nullable(),
});
export type DepositAddressList = z.infer<typeof depositAddressListSchema>;

export function createDepositReads(api: ApiClient) {
  return {
    assets: (signal?: AbortSignal): Promise<ApiResult<DepositCatalogue>> =>
      api.query('bank', 'deposits.assets', undefined, depositCatalogueSchema, { signal }),
    /** The person's own address for one asset on one network. The same call returns the same address. */
    async address(assetId: string, networkId: string): Promise<ApiResult<DepositAddressView>> {
      const result = await api.mutate('bank', 'deposits.address', { assetId, networkId }, depositAddressSchema);
      // An answer for a different pair is never shown as the one that was asked for.
      return result.ok && (result.data.assetId !== assetId || result.data.networkId !== networkId)
        ? {
            ok: false,
            reason: 'invalid_response',
            code: 'bank.deposit_catalogue_invalid',
            message: 'The address did not match the request.',
          }
        : result;
    },
    addresses: (assetId: string, networkId: string, signal?: AbortSignal): Promise<ApiResult<DepositAddressList>> =>
      api.query('bank', 'deposits.addresses.list', { assetId, networkId }, depositAddressListSchema, { signal }),
    createAddress: (assetId: string, networkId: string, label: string | null): Promise<ApiResult<DepositAddressItem>> =>
      api.mutate('bank', 'deposits.addresses.create', { assetId, networkId, label }, depositAddressItemSchema),
    labelAddress: (
      assetId: string,
      networkId: string,
      addressIndex: number,
      label: string | null,
    ): Promise<ApiResult<DepositAddressItem>> =>
      api.mutate('bank', 'deposits.addresses.label', { assetId, networkId, addressIndex, label }, depositAddressItemSchema),
  };
}

export function useDepositCatalogue() {
  const { api, userId } = useSession();
  return useResource<DepositCatalogue>(async (signal) => createDepositReads(api).assets(signal), `${userId}:deposit-catalogue`);
}

/** The states and reasons a deposit record can carry (W-deposit-05). Declared here for the same reason as the schemas above. */
export const DEPOSIT_STATUSES = [
  'detected',
  'confirming',
  'credited',
  'below_minimum',
  'held_for_screening',
  'held_for_release',
  'rejected',
  'reversed',
  'needs_review',
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];
export const DEPOSIT_REASONS = [
  'below_minimum',
  'amount_mismatch',
  'unknown_asset',
  'minimum_unset',
  'confirmations_unset',
  'chain_reorg',
  'reversal_unfunded',
  'address_expired',
] as const;

export const depositPendingSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      assetId: z.string().min(1),
      networkId: z.string().min(1),
      amount: decimalSchema,
      confirmations: z.number().int().nonnegative(),
      confirmationsRequired: z.number().int().nonnegative().nullable(),
    }),
  ),
});
export type DepositPending = z.infer<typeof depositPendingSchema>;

export const depositRecordSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  networkId: z.string().min(1),
  address: z.string().min(1),
  txHash: z.string().min(1),
  outputIndex: z.number().int().nonnegative(),
  amount: decimalSchema,
  confirmations: z.number().int().nonnegative(),
  confirmationsRequired: z.number().int().positive().nullable(),
  status: z.enum(DEPOSIT_STATUSES),
  reason: z.enum(DEPOSIT_REASONS).nullable(),
  minimumDeposit: decimalSchema.nullable(),
  detectedAt: z.string(),
  creditedAt: z.string().nullable(),
});
export type DepositRecordView = z.infer<typeof depositRecordSchema>;

export const depositRecordsSchema = z.object({ items: z.array(depositRecordSchema), total: z.number().int().nonnegative() });
export type DepositRecordsPage = z.infer<typeof depositRecordsSchema>;

export type DepositRecordFilters = { assetId?: string; status?: DepositStatus; txId?: string; address?: string };
export const DEPOSIT_RECORDS_PAGE = 20;

export function depositPendingRead(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<DepositPending>> {
  return api.query('bank', 'deposits.pending', undefined, depositPendingSchema, { signal });
}

/** The person's own deposit records, newest first. `limit` grows to load more; the service says the true total. */
export function depositRecordsRead(
  api: ApiClient,
  filters: DepositRecordFilters,
  limit: number,
  signal?: AbortSignal,
): Promise<ApiResult<DepositRecordsPage>> {
  return api.query('bank', 'deposits.list', { ...filters, offset: 0, limit }, depositRecordsSchema, { signal });
}

export function useDepositPending() {
  const { api, userId } = useSession();
  return useResource<DepositPending>((signal) => depositPendingRead(api, signal), `${userId}:deposit-pending`);
}

export function useDepositRecords(filters: DepositRecordFilters, limit: number) {
  const { api, userId } = useSession();
  return useResource<DepositRecordsPage>(
    (signal) => depositRecordsRead(api, filters, limit, signal),
    `${userId}:deposit-records:${JSON.stringify(filters)}:${limit}`,
  );
}
