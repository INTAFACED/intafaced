import type { z } from 'zod';
import {
  PAY_CUSTODY_DEPOSIT_REASONS,
  PAY_CUSTODY_DEPOSIT_STATUSES,
  payDepositTravelRuleDeclareInputSchema,
  payDepositTravelRuleGetInputSchema,
  payDepositTravelRuleViewSchema,
  type PayDepositTravelRuleView,
} from '@intafaced/contracts/pay-custody-deposit';
import {
  bankDepositAddressItemSchema as depositAddressItemSchema,
  bankDepositAddressListSchema as depositAddressListSchema,
  bankDepositAddressSchema as depositAddressSchema,
  bankDepositCatalogueSchema as depositCatalogueSchema,
  bankDepositHaltedSchema as depositHaltedSchema,
  bankDepositNetworkSchema as depositNetworkSchema,
  bankDepositPendingSchema as depositPendingSchema,
  bankDepositRecordSchema as depositRecordSchema,
  bankDepositRecordsSchema as depositRecordsSchema,
} from '@intafaced/contracts/bank-money-room';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiClient, ApiResult } from '../../shared/api';
import { contractProcedure, readContract } from '../../shared/contract-call';

/** What svc-bank answers the deposit pages, read with the schemas in `@intafaced/contracts/bank-money-room`. */
export {
  depositAddressItemSchema,
  depositAddressListSchema,
  depositAddressSchema,
  depositCatalogueSchema,
  depositHaltedSchema,
  depositNetworkSchema,
  depositPendingSchema,
  depositRecordSchema,
  depositRecordsSchema,
};
export type DepositNetworkView = z.infer<typeof depositNetworkSchema>;
export type DepositHaltedView = z.infer<typeof depositHaltedSchema>;
export type DepositCatalogue = z.infer<typeof depositCatalogueSchema>;
export type DepositAddressView = z.infer<typeof depositAddressSchema>;
export type DepositAddressItem = z.infer<typeof depositAddressItemSchema>;
export type DepositAddressList = z.infer<typeof depositAddressListSchema>;
export type DepositPending = z.infer<typeof depositPendingSchema>;
export type DepositRecordView = z.infer<typeof depositRecordSchema>;
export type DepositRecordsPage = z.infer<typeof depositRecordsSchema>;

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

/** The states and reasons a deposit record can carry (W-deposit-05), svc-pay's own lists. */
export const DEPOSIT_STATUSES = PAY_CUSTODY_DEPOSIT_STATUSES;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];
export const DEPOSIT_REASONS = PAY_CUSTODY_DEPOSIT_REASONS;

/** A deposit held for the inbound travel rule (W-deposit-07): the depositor's own record and declaration, straight from svc-pay. */
export const depositTravelRuleGet = contractProcedure('pay', 'custodyDeposit.travelRule.get', {
  input: payDepositTravelRuleGetInputSchema,
  output: payDepositTravelRuleViewSchema,
});
export const depositTravelRuleDeclare = contractProcedure('pay', 'custodyDeposit.travelRule.declare', {
  input: payDepositTravelRuleDeclareInputSchema,
  output: payDepositTravelRuleViewSchema,
});
export type DepositTravelRuleView = PayDepositTravelRuleView;

export function useDepositTravelRule(depositId: string) {
  const { api, userId } = useSession();
  return useResource<DepositTravelRuleView>(
    (signal) => readContract(api, depositTravelRuleGet, { depositId }, { signal }),
    `${userId}:deposit-travel-rule:${depositId}`,
  );
}

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
