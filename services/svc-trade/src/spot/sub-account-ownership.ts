import {
  serviceCallSigner,
  subAccountOwnershipSchema,
  type ServiceAuthMode,
  type ServiceSigner,
  type SubAccountOwnership,
} from '@intafaced/contracts';
import { TradeError } from './types.js';

/**
 * SUB-ACCOUNT OWNERSHIP GATE (§4.1 sub_accounts · mega-audit R5 residual).
 *
 * placeOrder may label an order with `subAccountId`. That id is only safe to
 * store after identity confirms (a) it exists, (b) the edge principal is the
 * parent, and (c) it is not revoked. Without that consult, any UUID would be
 * accepted — including a stranger's book or a retired one.
 *
 * FAILS CLOSED. Identity down, unparseable body, or missing credentials must
 * refuse the order before a hold is taken. Nothing has moved yet; that is why
 * strict is correct here (same posture as rank perks at accept).
 *
 * Funds still hold on the parent user via existing orderHold recipes — this
 * gate is ownership of the label, not a second ledger book path.
 */
export interface SubAccountOwnershipSource {
  /**
   * Snapshot for one id, or null when identity has no such row.
   * Throws TradeError `trade.sub_account_unavailable` on transport/auth/parse failure.
   */
  get(subAccountId: string): Promise<SubAccountOwnership | null>;
}

/** Used by tests that never place sub-account orders. */
export class NoSubAccounts implements SubAccountOwnershipSource {
  async get(): Promise<SubAccountOwnership | null> {
    return null;
  }
}

/**
 * HTTP client for svc-identity `GET /internal/sub-accounts/:id`.
 *
 * Same service-credential pattern as `createRankPerksClient` — unauthenticated
 * callers hard-401, and we treat every non-success (except 404) as unavailable.
 */
export function createSubAccountOwnershipClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): SubAccountOwnershipSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  const authHeaders = (target: string) => sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' });

  return {
    async get(subAccountId: string): Promise<SubAccountOwnership | null> {
      let response: Response;
      try {
        const target = `${url}/internal/sub-accounts/${encodeURIComponent(subAccountId)}`;
        response = await fetch(target, {
          method: 'GET',
          headers: { 'content-type': 'application/json', ...authHeaders(target) },
        });
      } catch (err) {
        throw new TradeError(`sub-account ownership unavailable: ${(err as Error).message}`, 'trade.sub_account_unavailable');
      }

      if (response.status === 404) return null;

      if (!response.ok) {
        throw new TradeError(`sub-account ownership unavailable (${response.status})`, 'trade.sub_account_unavailable');
      }

      const body: unknown = await response.json();
      const parsed = subAccountOwnershipSchema.safeParse(body);
      if (!parsed.success) {
        throw new TradeError('sub-account ownership payload did not match the published contract', 'trade.sub_account_unavailable');
      }

      return parsed.data;
    },
  };
}

/**
 * Assert the principal may trade under `subAccountId`.
 *
 * Call before any order row or hold. Foreign / missing / revoked all refuse;
 * foreign and missing share one code so existence is not leaked to an attacker.
 */
export async function assertSubAccountOwned(source: SubAccountOwnershipSource, userId: string, subAccountId: string): Promise<void> {
  const row = await source.get(subAccountId);
  if (!row || row.parentUserId !== userId) {
    throw new TradeError('sub-account not found', 'trade.sub_account_denied');
  }
  if (row.revoked) {
    throw new TradeError('sub-account is revoked', 'trade.sub_account_revoked');
  }
}
