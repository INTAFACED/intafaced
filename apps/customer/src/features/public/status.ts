// hand-declared-ok: the markets answer adds `lifecycle`, which the exchange-contract market schema does not carry
import { z } from 'zod';
import { marketSchema } from '@intafaced/exchange-contract/schemas';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Fetcher } from '../../data/poll';
import { statusPageSchema } from '@intafaced/contracts/status-page';
import {
  statusChallengeMet,
  statusChallengeSchema,
  statusChallengeText,
  statusLinkInputSchema,
  statusSubscribeInputSchema,
  statusSubscribeResultSchema,
  statusSubscriptionPolicySchema,
  statusSubscriptionSchema,
  statusSubscriptionUpdateInputSchema,
  type StatusChallenge,
} from '@intafaced/contracts/status-subscriptions';
import { readStatusFeed, type StatusFeed } from '../developers/developers-api';
import { contractProcedure, readContract, type ContractData } from '../../shared/contract-call';

export type MaintenanceWindow = StatusFeed['maintenance'][number];

/** The published maintenance windows from the public status feed. A window with no start or end keeps that time unset. */
export function maintenanceFetcher(api: ApiClient): Fetcher<MaintenanceWindow[]> {
  return async (signal): Promise<ApiResult<MaintenanceWindow[]>> => {
    const result = await readStatusFeed(api, signal);
    return result.ok ? { ok: true, data: result.data.maintenance } : result;
  };
}

/** One market's trading mode as the service reports it. `state` is null when the service reported none: never assumed open. */
export interface MarketMode {
  symbol: string;
  state: string | null;
  reasonCode: string | null;
}

const statusListingSchema = marketSchema.pick({ symbol: true, spot: true, paper: true }).extend({
  lifecycle: z.object({ state: z.string(), reasonCode: z.string().nullish() }).passthrough().nullish(),
});

/** The public markets read, kept to the fields /status shows. Spot, real (not paper) markets only. */
export function marketModesFetcher(api: ApiClient): Fetcher<MarketMode[]> {
  return async (signal): Promise<ApiResult<MarketMode[]>> => {
    const result = await api.rest('/markets', z.array(statusListingSchema), { query: { limit: 500 }, signal });
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data
        .filter((m) => m.spot && !m.paper)
        .map((m) => ({ symbol: m.symbol, state: m.lifecycle?.state ?? null, reasonCode: m.lifecycle?.reasonCode ?? null })),
    };
  };
}

export type ModeKey =
  'OPEN' | 'POST_ONLY' | 'LIMIT_ONLY' | 'CANCEL_ONLY' | 'REDUCE_ONLY' | 'HALTED' | 'DELISTING' | 'PRELAUNCH' | 'REFUSED';

const KNOWN: ReadonlySet<string> = new Set<ModeKey>([
  'OPEN',
  'POST_ONLY',
  'LIMIT_ONLY',
  'CANCEL_ONLY',
  'REDUCE_ONLY',
  'HALTED',
  'DELISTING',
  'PRELAUNCH',
  'REFUSED',
]);

/** The mode we have words for, or null (no state reported, or a state this page does not describe). */
export function knownMode(state: string | null): ModeKey | null {
  return state !== null && KNOWN.has(state) ? (state as ModeKey) : null;
}

export type StatusPage = ContractData<typeof statusPageRead>;

const statusPageRead = contractProcedure('notify', 'statusPage.read', { output: statusPageSchema });

/** The founders' status page: defined components, their states, the uptime strip and incidents. Signed-out. */
export function statusPageFetcher(api: ApiClient): Fetcher<StatusPage> {
  return (signal) => readContract(api, statusPageRead, undefined, { signal });
}

// hand-declared-ok: svc-notify's published postmortem output (statusPage.postmortems.published), not in contracts yet
const publishedPostmortemSchema = z.object({
  incidentId: z.string(),
  body: z.string(),
  version: z.number().int(),
  publishedAt: z.string(),
});
export type PublishedPostmortem = z.infer<typeof publishedPostmortemSchema>;

const statusPostmortemsRead = contractProcedure('notify', 'statusPage.postmortems.published', {
  input: z.object({ limit: z.number().int() }),
  output: z.array(publishedPostmortemSchema),
});

/** The most svc-notify answers in one read (POSTMORTEMS_LIST_MAX). */
const POSTMORTEMS_READ_MAX = 200;

/**
 * Postmortems a second founder approved and one published, newest first, by incident. Signed-out; no author. The newest
 * 200: more than the incidents of the 90 days /status lists are likely to carry.
 */
export function statusPostmortemsFetcher(api: ApiClient): Fetcher<PublishedPostmortem[]> {
  return (signal) => readContract(api, statusPostmortemsRead, { limit: POSTMORTEMS_READ_MAX }, { signal });
}

export const statusSubscriptionPolicy = contractProcedure('notify', 'statusPage.subscriptions.policy', {
  output: statusSubscriptionPolicySchema,
});
export const statusSubscriptionChallenge = contractProcedure('notify', 'statusPage.subscriptions.challenge', {
  output: statusChallengeSchema,
});
export const statusSubscribe = contractProcedure('notify', 'statusPage.subscriptions.subscribe', {
  input: statusSubscribeInputSchema,
  output: statusSubscribeResultSchema,
});
export const statusSubscriptionConfirm = contractProcedure('notify', 'statusPage.subscriptions.confirm', {
  input: statusLinkInputSchema,
  output: statusSubscriptionSchema.extend({ manageToken: z.string() }),
});
export const statusSubscriptionGet = contractProcedure('notify', 'statusPage.subscriptions.get', {
  input: statusLinkInputSchema,
  output: statusSubscriptionSchema,
});
export const statusSubscriptionUpdate = contractProcedure('notify', 'statusPage.subscriptions.update', {
  input: statusSubscriptionUpdateInputSchema,
  output: statusSubscriptionSchema,
});
export const statusUnsubscribe = contractProcedure('notify', 'statusPage.subscriptions.unsubscribe', {
  input: statusLinkInputSchema,
  output: statusSubscriptionSchema,
});

/**
 * Finds a nonce whose sha256 over `token:nonce` starts with the challenge's zero bits. Runs in the browser with the
 * platform's own hash; nothing third-party sees the visitor. Yields to the page every few hundred tries.
 */
export async function solveStatusChallenge(challenge: StatusChallenge, signal?: AbortSignal): Promise<string> {
  const encoder = new TextEncoder();
  for (let n = 0; ; n += 1) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const nonce = n.toString(36);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(statusChallengeText(challenge.token, nonce))));
    if (statusChallengeMet(digest, challenge.bits)) return nonce;
    if (n % 500 === 499) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
