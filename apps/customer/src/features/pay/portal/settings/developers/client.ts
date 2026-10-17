import { z } from 'zod';
import type { SettingsBTools } from '../b-client';
import { tolerantPage } from '../b-shared';
import { pagedResult } from '../../ui/page';
import * as s from './schemas';

export const developersApi = ({ query, mutate, identityQuery, identityMutate }: SettingsBTools) => ({
  // ---- API keys and request signing (identity service) ----
  keysList: (signal?: AbortSignal) => identityQuery('apiKeys.list', { limit: 200 }, z.array(s.keySchema), signal),
  keyCreate: (input: { name: string; scopes: string[] }) =>
    identityMutate('apiKeys.create', { ...input, mode: 'sandbox' }, s.createdKeySchema),
  keyRevoke: (keyId: string) => identityMutate('apiKeys.revoke', { keyId }, s.revokedSchema),
  signingSet: (keyId: string, requireSignature: boolean, requireNonEmptyIpAllowlist: boolean) =>
    identityMutate('setApiKeyRequestSigning', { keyId, requireSignature, requireNonEmptyIpAllowlist }, s.signingSchema),
  signingRotate: (keyId: string) => identityMutate('rotateSigningSecret', { keyId }, s.rotatedSigningSchema),
  ipsBind: (keyId: string, ips: string[]) => identityMutate('bindApiKeyIpAllowlist', { keyId, ips }, s.ipListSchema),
  ipsUnbind: (keyId: string, ip: string) => identityMutate('unbindApiKeyIpAllowlist', { keyId, ip }, s.ipListSchema),
  // ---- webhooks (merchantOps.webhooks.*) ----
  endpointsList: async (cursor: string | undefined, status: string, search: string, signal?: AbortSignal) =>
    pagedResult(await query(
      'merchantOps.webhooks.list',
      { limit: 25, ...(cursor ? { cursor } : {}), ...(status ? { status } : {}), ...(search ? { search } : {}) },
      tolerantPage(s.endpointSchema),
      signal,
    )),
  endpointCreate: (url: string) => mutate('merchantOps.webhooks.create', { url }, s.createdEndpointSchema),
  endpointUpdate: (endpointId: string, url: string) => mutate('merchantOps.webhooks.update', { endpointId, url }, s.endpointSchema),
  endpointDisable: (endpointId: string) => mutate('merchantOps.webhooks.disable', { endpointId }, s.endpointSchema),
  endpointRotate: (endpointId: string, requestId: string) =>
    mutate('merchantOps.webhooks.rotateSecret', { endpointId, requestId }, s.rotatedEndpointSchema),
  deliveriesList: async (
    cursor: string | undefined,
    filter: { endpointId?: string; status?: string; from?: string; to?: string },
    signal?: AbortSignal,
  ) =>
    pagedResult(await query(
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
    )),
  deliveryRetry: (deliveryId: string, requestId: string) =>
    mutate('merchantOps.webhooks.deliveries.retry', { deliveryId, requestId }, s.retriedSchema),
  webhookHealth: (signal?: AbortSignal) => query('merchantOps.webhooks.health', {}, s.healthSchema, signal),
});
