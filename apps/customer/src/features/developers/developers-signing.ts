import { requestSigningPolicySchema, type RequestSigningPolicy } from '@intafaced/contracts/api-keys';
import type { ApiClient, ApiResult } from '../../shared/api';

/**
 * Identity's published request-signing policy (DV-auth-01): the owner's timestamp window, null while it is not set,
 * and one TEST request signed by the service's own signer. Public: the pages read it before anyone signs in, so the
 * window a page names is the one the server enforces, never a number written here.
 */
export function readSigningPolicy(api: Pick<ApiClient, 'query'>, signal?: AbortSignal): Promise<ApiResult<RequestSigningPolicy>> {
  return api.query('identity', 'requestSigningPolicy', undefined, requestSigningPolicySchema, signal ? { signal } : {});
}
