import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import {
  createMatchingClient as createMatchingClientInner,
  MatchingUnavailableError,
  MATCHING_FETCH_MS,
  type EngineSubmitResult,
  type MatchingClient,
} from './matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import { env } from '../env.js';

/**
 * Matching flatten door. Sibling of matching-client.ts so that file never moves.
 * POST /markets/:marketId/positions/close — svc-trade only, PLACE proof.
 * Trade does not invent qty, side, or a mark.
 */

export interface MatchingCloseRequest {
  readonly orderId: string;
  readonly accountId: string;
  readonly lifecycleProof: LifecycleAdmissionProof;
}

export type MatchingClientWithClose = MatchingClient & {
  closePosition(marketId: string, request: MatchingCloseRequest): Promise<EngineSubmitResult>;
};

export function hasClosePosition(matching: MatchingClient): matching is MatchingClientWithClose {
  return typeof (matching as MatchingClientWithClose).closePosition === 'function';
}

let boundS2s: { signer: ServiceSigner; mode: ServiceAuthMode } | undefined;

/** The env-addressed close below has no client to carry the signer, so `index.ts` binds it once. Unbound leaves the shared secret alone. */
export function bindMatchingCloseS2s(s2s: { signer: ServiceSigner; mode: ServiceAuthMode } | undefined): void {
  boundS2s = s2s;
}

export async function closePositionOnMatching(
  matching: MatchingClient,
  marketId: string,
  request: MatchingCloseRequest,
): Promise<EngineSubmitResult> {
  if (hasClosePosition(matching)) {
    return matching.closePosition(marketId, request);
  }
  return postClosePosition(env.MATCHING_URL, env.INTERNAL_SERVICE_SECRET, marketId, request, boundS2s);
}

export async function postClosePosition(
  baseUrl: string,
  internalSecret: string,
  marketId: string,
  request: MatchingCloseRequest,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  timeoutMs: number = MATCHING_FETCH_MS,
): Promise<EngineSubmitResult> {
  const url = baseUrl.replace(/\/$/, '');
  const path = `/markets/${encodeURIComponent(marketId)}/positions/close`;
  const payload = JSON.stringify(request);
  const authHeaders = serviceCallSigner({ service: 'svc-trade', audience: 'svc-matching', legacySecret: internalSecret, s2s });
  const target = `${url}${path}`;
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(payload, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
      },
      body: payload,
      // Bounded like every other engine call: a hung engine ends as unreachable, not as a request that never returns.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as EngineSubmitResult;
}

export function createMatchingClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  options: { timeoutMs?: number } = {},
): MatchingClientWithClose {
  const inner = createMatchingClientInner(baseUrl, internalSecret, s2s, options);
  return Object.assign(inner, {
    closePosition(marketId: string, request: MatchingCloseRequest) {
      return postClosePosition(baseUrl, internalSecret, marketId, request, s2s, options.timeoutMs);
    },
  });
}
