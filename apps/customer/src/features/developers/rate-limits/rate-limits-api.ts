/**
 * The rate-limits page's reads and its one write (DV-limits-01 to 03, J-developer-06): the owner's tiers from
 * svc-identity, the per-route cost table from the edge, the caller's own limit requests, and a new request. Shapes are
 * the contracts' (`@intafaced/contracts/api-rate-limits`); a reply that does not match is refused, never shown.
 */
import {
  rateCostsOutputSchema,
  type LimitRequest,
  type LimitRequestCreateInput,
  type LimitRequestListOutput,
  type RateCostsOutput,
  type RateTiersOutput,
} from '@intafaced/contracts/api-rate-limits';
import type { ApiClient, ApiResult } from '../../../shared/api';
import { IDENTITY_API_RATE_TIERS } from '@intafaced/contracts/identity-api-rate-tiers-procedures';
import {
  IDENTITY_API_LIMIT_REQUESTS_LIST_MINE,
  IDENTITY_API_LIMIT_REQUESTS_CREATE,
} from '@intafaced/contracts/identity-api-limit-requests-procedures';

export const readRateTiers = (api: ApiClient, signal: AbortSignal): Promise<ApiResult<RateTiersOutput>> =>
  api.call(IDENTITY_API_RATE_TIERS, undefined, { signal });

export const readRateCosts = (api: ApiClient, signal: AbortSignal): Promise<ApiResult<RateCostsOutput>> =>
  api.plain('edge', '/rate-limits/costs', rateCostsOutputSchema, { signal });

export const readMyLimitRequests = (api: ApiClient, signal: AbortSignal): Promise<ApiResult<LimitRequestListOutput>> =>
  api.call(IDENTITY_API_LIMIT_REQUESTS_LIST_MINE, undefined, { signal });

export const sendLimitRequest = (api: ApiClient, input: LimitRequestCreateInput): Promise<ApiResult<LimitRequest>> =>
  api.call(IDENTITY_API_LIMIT_REQUESTS_CREATE, input);

/** The typed refusals the form names in its own words; anything else goes to the shared failure panel. */
export const LIMIT_FORM_REFUSALS = [
  'identity.rate_limits_unset',
  'identity.key_not_found',
  'identity.key_not_live',
  'identity.limit_not_higher',
  'identity.limit_key_sandbox',
  'identity.limit_spike_invalid',
  'identity.limit_request_open',
] as const;
export type LimitFormRefusal = (typeof LIMIT_FORM_REFUSALS)[number];

export function limitFormRefusal(result: Extract<ApiResult<unknown>, { ok: false }>): LimitFormRefusal | null {
  return (LIMIT_FORM_REFUSALS as readonly string[]).includes(result.code ?? '') ? (result.code as LimitFormRefusal) : null;
}

/** A fresh id for one press of Send: a retry of the same press reuses it, a new press makes a new one. */
export const newSubmissionId = (): string => `limit-request:${crypto.randomUUID()}`;
