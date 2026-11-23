import type { SettingsBTools } from '../b-client';
import { tolerantPage } from '../b-shared';
import { pagedResult } from '../../ui/page';
import type { ApiResult } from '../../../../../shared/api';
import { developersCopy } from './copy';
import * as s from './schemas';
import {
  IDENTITY_API_KEYS_LIST,
  IDENTITY_API_KEYS_CREATE,
  IDENTITY_API_KEYS_REVOKE,
} from '@intafaced/contracts/identity-api-keys-procedures';
import { IDENTITY_ROTATE_SIGNING_SECRET } from '@intafaced/contracts/identity-rotate-signing-secret-procedures';
import { IDENTITY_SET_API_KEY_REQUEST_SIGNING } from '@intafaced/contracts/identity-set-api-key-request-signing-procedures';
import { IDENTITY_BIND_API_KEY_IP_ALLOWLIST } from '@intafaced/contracts/identity-bind-api-key-ip-allowlist-procedures';
import { IDENTITY_UNBIND_API_KEY_IP_ALLOWLIST } from '@intafaced/contracts/identity-unbind-api-key-ip-allowlist-procedures';
import {
  PAY_MERCHANT_OPS_WEBHOOKS_HEALTH,
  PAY_MERCHANT_OPS_WEBHOOKS_DELIVERIES_ATTEMPTS,
  PAY_MERCHANT_OPS_WEBHOOKS_POLICY,
  PAY_MERCHANT_OPS_WEBHOOKS_GUIDE,
} from '@intafaced/contracts/pay-merchant-ops-procedures';

/** An answer that says "no" in its data (`revoked: false`) is a refusal in words, never a quiet success. */
const refusedWhen = <T>(result: ApiResult<T>, notDone: (data: T) => boolean, words: () => string): ApiResult<T> =>
  result.ok && notDone(result.data) ? { ok: false, reason: 'error', code: 'portal.local', message: words() } : result;

export const developersApi = ({ query, mutate, identityQueryRecord, identityMutateRecord, queryRecord }: SettingsBTools) => ({
  // ---- API keys and request signing (identity service) ----
  keysList: (signal?: AbortSignal) => identityQueryRecord(IDENTITY_API_KEYS_LIST, { limit: 200 }, signal),
  keyCreate: (input: { name: string; scopes: string[] }) => identityMutateRecord(IDENTITY_API_KEYS_CREATE, { ...input, mode: 'sandbox' }),
  keyRevoke: async (keyId: string) =>
    refusedWhen(
      await identityMutateRecord(IDENTITY_API_KEYS_REVOKE, { keyId }),
      (d) => !d.revoked,
      () => developersCopy.t('revokeRefused'),
    ),
  signingSet: (keyId: string, requireSignature: boolean, requireNonEmptyIpAllowlist: boolean) =>
    identityMutateRecord(IDENTITY_SET_API_KEY_REQUEST_SIGNING, { keyId, requireSignature, requireNonEmptyIpAllowlist }),
  signingRotate: (keyId: string) => identityMutateRecord(IDENTITY_ROTATE_SIGNING_SECRET, { keyId }),
  ipsBind: (keyId: string, ips: string[]) => identityMutateRecord(IDENTITY_BIND_API_KEY_IP_ALLOWLIST, { keyId, ips }),
  ipsUnbind: (keyId: string, ip: string) => identityMutateRecord(IDENTITY_UNBIND_API_KEY_IP_ALLOWLIST, { keyId, ip }),
  // ---- webhooks (merchantOps.webhooks.*) ----
  endpointsList: async (cursor: string | undefined, status: string, search: string, signal?: AbortSignal) =>
    pagedResult(
      await query(
        'merchantOps.webhooks.list',
        { limit: 25, ...(cursor ? { cursor } : {}), ...(status ? { status } : {}), ...(search ? { search } : {}) },
        tolerantPage(s.endpointSchema),
        signal,
      ),
    ),
  endpointCreate: (url: string, eventTypes: readonly string[]) =>
    mutate('merchantOps.webhooks.create', { url, eventTypes: [...eventTypes] }, s.createdEndpointSchema),
  endpointUpdate: (endpointId: string, url: string) => mutate('merchantOps.webhooks.update', { endpointId, url }, s.endpointSchema),
  endpointDisable: (endpointId: string) => mutate('merchantOps.webhooks.disable', { endpointId }, s.endpointSchema),
  endpointRotate: (endpointId: string, requestId: string, overlapSeconds = 0) =>
    mutate('merchantOps.webhooks.rotateSecret', { endpointId, requestId, overlapSeconds }, s.rotatedEndpointSchema),
  deliveriesList: async (
    cursor: string | undefined,
    filter: { endpointId?: string; status?: string; from?: string; to?: string },
    signal?: AbortSignal,
  ) =>
    pagedResult(
      await query(
        'merchantOps.webhooks.deliveries.list',
        {
          limit: 25,
          ...(cursor ? { cursor } : {}),
          ...(filter.endpointId ? { endpointId: filter.endpointId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.from ? { from: filter.from } : {}),
          ...(filter.to ? { to: filter.to } : {}),
        },
        tolerantPage(s.deliverySchema),
        signal,
      ),
    ),
  // `retried: false` is the replay answer for a request id the service already recorded: the earlier request was
  // queued. A real refusal arrives as an error code, so both answers count as done.
  deliveryRetry: (deliveryId: string, requestId: string) =>
    mutate('merchantOps.webhooks.deliveries.retry', { deliveryId, requestId }, s.retriedSchema),
  webhookHealth: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_WEBHOOKS_HEALTH, {}, signal),
  deliveryAttempts: (deliveryId: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_OPS_WEBHOOKS_DELIVERIES_ATTEMPTS, { deliveryId }, signal),
  deliveriesRecover: (endpointId: string, since: string, requestId: string) =>
    mutate('merchantOps.webhooks.deliveries.recover', { endpointId, since, requestId }, s.recoveredSchema),
  webhookPolicy: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_WEBHOOKS_POLICY, {}, signal),
  webhookCatalogue: (signal?: AbortSignal) => query('merchantOps.webhooks.catalogue', {}, s.catalogueSchema, signal),
  webhookGuide: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_WEBHOOKS_GUIDE, {}, signal),
});
