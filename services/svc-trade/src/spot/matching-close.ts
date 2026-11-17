import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import {
  createMatchingClient as createMatchingClientInner,
  MatchingUnavailableError,
  MATCHING_FETCH_MS,
  type EngineSubmitResult,
  type MatchingClient,
} from './matching-client.js';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
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
  /** Signed net fill qty of one account on one book (GET /markets/:marketId/positions/:accountId). */
  netPosition(marketId: string, accountId: string): Promise<Amount>;
};

export function hasClosePosition(matching: MatchingClient): matching is MatchingClientWithClose {
  return typeof (matching as MatchingClientWithClose).closePosition === 'function';
}

function hasNetPosition(matching: MatchingClient): matching is MatchingClient & Pick<MatchingClientWithClose, 'netPosition'> {
  return typeof (matching as MatchingClientWithClose).netPosition === 'function';
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

/**
 * The account's signed net on this book, read before a close is sized and held (#4591): positive long, negative short.
 * The engine owns the net; trade never derives it from its own rows.
 */
export async function readNetPositionOnMatching(matching: MatchingClient, marketId: string, accountId: string): Promise<Amount> {
  if (hasNetPosition(matching)) return matching.netPosition(marketId, accountId);
  return getNetPosition(env.MATCHING_URL, env.INTERNAL_SERVICE_SECRET, marketId, accountId, boundS2s);
}

export async function getNetPosition(
  baseUrl: string,
  internalSecret: string,
  marketId: string,
  accountId: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  timeoutMs: number = MATCHING_FETCH_MS,
): Promise<Amount> {
  const url = baseUrl.replace(/\/$/, '');
  const path = `/markets/${encodeURIComponent(marketId)}/positions/${encodeURIComponent(accountId)}`;
  const authHeaders = serviceCallSigner({ service: 'svc-trade', audience: 'svc-matching', legacySecret: internalSecret, s2s });
  const target = `${url}${path}`;
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'GET',
      headers: authHeaders('', { method: 'GET', url: new URL(target), contentType: '' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new MatchingUnavailableError(`svc-matching ${path} is unreachable: ${(err as Error).message}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new MatchingUnavailableError(`svc-matching ${path} failed (${response.status}): ${detail}`);
  }
  let body: { qty?: unknown };
  try {
    body = (await response.json()) as { qty?: unknown };
  } catch (err) {
    throw new MatchingUnavailableError(`svc-matching ${path} returned a body that is not JSON: ${(err as Error).message}`);
  }
  if (typeof body.qty !== 'string') throw new MatchingUnavailableError(`svc-matching ${path} returned no position qty`);
  try {
    return parseAmount(body.qty);
  } catch {
    throw new MatchingUnavailableError(`svc-matching ${path} returned a position qty that is not a decimal`);
  }
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
    netPosition(marketId: string, accountId: string) {
      return getNetPosition(baseUrl, internalSecret, marketId, accountId, s2s, options.timeoutMs);
    },
  });
}
