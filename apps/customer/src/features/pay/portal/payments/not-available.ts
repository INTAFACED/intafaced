import type { ApiResult } from '../../../../shared/api';
import { paymentsCopy } from './copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * The gateway answered "no such procedure" (HTTP 404, tRPC NOT_FOUND): the request never reached the service, so nothing
 * ran and nothing can be waiting. A service's own "not found" carries a `pay.` code and is a different answer.
 */
export function neverRan(result: ApiResult<unknown>): result is Failed {
  if (result.ok) return false;
  if (result.code?.startsWith('pay.')) return false;
  return (
    result.reason === 'not_mounted' ||
    result.reason === 'not_supported' ||
    result.status === 404 ||
    result.code === 'NOT_FOUND' ||
    /no procedure/i.test(result.message)
  );
}

/**
 * Passes every result through unchanged except a call that never ran. That becomes one clear, definite refusal
 * ("not available, nothing was changed"). It is never `uncertain`, so no page locks itself waiting for an outcome.
 */
export function definite<T>(result: ApiResult<T>): ApiResult<T> {
  if (!neverRan(result)) return result;
  return { ok: false, reason: 'not_supported', code: 'portal.local', message: paymentsCopy.t('notAvailableNow'), status: result.status };
}
