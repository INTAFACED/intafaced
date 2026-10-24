import type { z, ZodType } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';
import { portalRefusal, refusalText } from './refusal';
import * as p from './schemas';
import { confirmDestination, type DestinationProof } from './access/destination-step-up';

export const PAGE_SIZE = 25;

/**
 * The three ways any portal call is made. Each package builds its own methods on these, so no package edits
 * another's client. The merchant is never taken from here: every procedure scopes itself from the signed session.
 */
export function portalTools(api: ApiClient, userId: string | null) {
  const signedIn = () => (userId ? null : portalRefusal('signInRequired', 'unauthorized'));
  async function query<T>(procedure: string, input: unknown, schema: ZodType<T>, signal?: AbortSignal): Promise<ApiResult<T>> {
    return signedIn() ?? api.query('pay', procedure, input, schema, { signal });
  }
  /** A refused change comes back with its message already in plain words, because the shared review dialog prints `message` as it finds it. */
  async function mutate<T>(procedure: string, input: unknown, schema: ZodType<T>): Promise<ApiResult<T>> {
    const denied = signedIn();
    if (denied) return denied;
    const result = await api.mutate('pay', procedure, input, schema);
    return result.ok ? result : { ...result, message: refusalText(result) };
  }
  const list = <T extends z.ZodTypeAny>(procedure: string, item: T, input: Record<string, unknown>, signal?: AbortSignal) =>
    query(procedure, { limit: PAGE_SIZE, ...input }, p.page(item), signal);
  /** The fresh-code confirmation a payout destination needs is asked of the identity service, on the same session. */
  const confirmDestinationStepUp = (
    destination: { merchantId: string; railId: string; kind: string; ref: string },
    proof: DestinationProof,
  ) => signedIn() ?? confirmDestination(api, destination, proof);
  return { userId, query, mutate, list, confirmDestinationStepUp };
}
export type PortalTools = ReturnType<typeof portalTools>;
