import {
  BASE_PERKS,
  rankPerksSchema,
  serviceCallSigner,
  type RankPerks,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { TradeError } from './types.js';

/**
 * RANK PERKS (§4.1, §5.2 "fee-tier").
 *
 * svc-identity owns the ladder; this service reads one field from it. The
 * contract shape lives in `packages/contracts`, so a change to the perk table
 * is a compile error here rather than a silently ignored field.
 *
 * WHEN this is read matters more than how. It is read ONCE, at order placement,
 * and the result is snapshotted onto the order row. Two consequences, both
 * deliberate:
 *
 *   1. A rank change cannot retroactively re-price an order that was already
 *      accepted on the old terms — the same reason `token.stakes` snapshots its
 *      multiplier at open.
 *   2. The fill path makes no network call. A fill must settle even when
 *      svc-identity is down, because by then the match has already printed and
 *      the counterparty is already owed.
 */
export interface RankPerksSource {
  perksOf(userId: string): Promise<RankPerks>;
}

/** Rank 0 for everyone. Used by tests and by a dev stack running without svc-identity. */
export class BasePerks implements RankPerksSource {
  async perksOf(): Promise<RankPerks> {
    return BASE_PERKS;
  }
}

/**
 * HTTP client for svc-identity's `rank.perks`.
 *
 * FAILS CLOSED. If the perk table cannot be read, the order is refused before
 * anything is held — the alternative is charging a discounted trader the full
 * rate because a service they cannot see was unavailable, and a fee taken in
 * error is far harder to unwind than an order that was never placed. Nothing
 * has moved at this point in the flow, which is exactly why this is the right
 * place to be strict.
 */
export function createRankPerksClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): RankPerksSource {
  const url = baseUrl.replace(/\/$/, '');

  /**
   * SERVICE CREDENTIALS, which this client was calling without.
   *
   * `/internal/rank/:userId/perks` hard-401s an unauthenticated caller — it was
   * unauthenticated once (full audit L2-3) and was fixed. This client was never
   * updated to match, so every call returned 401, `perksOf` threw
   * `trade.perks_unavailable`, and because it is awaited BEFORE the hold on the
   * order-create path, **every order placement failed on the running fleet.**
   *
   * It failed closed, which is the correct direction and is why nothing was
   * mispriced — but the whole spot path was down rather than degraded, and the
   * error named a dependency rather than a credential.
   */
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  const authHeaders = (target: string) => sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' });

  return {
    async perksOf(userId: string): Promise<RankPerks> {
      let response: Response;
      try {
        // Internal S2S path (mounted with Core). Avoids requiring a user principal
        // on rank.perks while still failing closed on transport/parse errors.
        const target = `${url}/internal/rank/${encodeURIComponent(userId)}/perks`;
        response = await fetch(target, {
          method: 'GET',
          headers: { 'content-type': 'application/json', ...authHeaders(target) },
        });
      } catch (err) {
        throw new TradeError(`rank perks unavailable: ${(err as Error).message}`, 'trade.perks_unavailable');
      }

      if (!response.ok) {
        throw new TradeError(`rank perks unavailable (${response.status})`, 'trade.perks_unavailable');
      }

      const body = await response.json();
      const parsed = rankPerksSchema.safeParse(body);
      if (!parsed.success) {
        // A perk table we cannot parse is a perk table we must not guess at.
        throw new TradeError('rank perks payload did not match the published contract', 'trade.perks_unavailable');
      }

      return parsed.data;
    },
  };
}
