import { accountStateSchema, serviceCallSigner, type AccountState, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { IdentityGroundingUnwiredError, identitySecretSet } from './identity-grounding-honesty.js';

/**
 * ACCOUNT STATE, READ FROM THE SERVICE THAT OWNS IT (§8.2 "account-state
 * grounded").
 *
 * A support desk needs to know whether an account is frozen and how far it is
 * verified. There are exactly two ways to arrange that, and only one of them is
 * allowed here:
 *
 *   · Copy it. Subscribe to identity events, keep a `support.accounts` table,
 *     render from that. Fast, and wrong: the moment the desk holds its own copy
 *     of account status, an operator can freeze-check against a projection that
 *     is minutes stale and tell a user their account is fine while compliance
 *     has already locked it. That is a second book for a non-money fact, and it
 *     fails the same way the money one does.
 *   · Read it, per request, from svc-identity, and record WHEN you read it.
 *
 * This is the second. It follows the read-port convention already used by
 * `svc-trade/src/spot/rank-perks.ts` and `svc-academy/src/stake-source.ts`:
 * the consumer declares the interface it needs, a null implementation covers
 * tests and a dev stack running without the dependency, and production injects
 * an HTTP client validated against the published contract.
 *
 * FAILING CLOSED HERE MEANS SAYING "I DID NOT READ IT", NOT THROWING THE USER
 * OUT. That is the one place this diverges from `rank-perks`, on purpose:
 * rank-perks refuses the order, because mispricing a fee is worse than not
 * placing a trade. Here the operator is mid-conversation with a person who
 * already has a problem, and refusing to let them escalate because a service
 * they cannot see is down would strand that person. So a dark plane produces a
 * case file that SAYS the account was never read (`grounding.status: 'unread'`,
 * `reason: 'plane_dark'`) — degraded and honest about it, rather than either
 * silently blank or hard-refused.
 */
export interface AccountStateSource {
  /** The projection, or null when this source cannot answer at all. */
  stateOf(userId: string): Promise<AccountState | null>;
}

/**
 * No identity dependency configured.
 *
 * Returns null rather than throwing, and never invents `status: 'active'` —
 * which is the failure mode worth naming, because 'active' is both the common
 * case and the answer that makes a frozen account look usable.
 */
export class DarkAccountState implements AccountStateSource {
  async stateOf(): Promise<AccountState | null> {
    return null;
  }
}

/**
 * HTTP client for svc-identity's `GET /internal/account/:userId`.
 *
 * S2S-authenticated with the shared internal secret — the same control as
 * `/internal/rank/:userId/perks`, and for the same reason: the tRPC surface
 * that exposes account facts is a `scopedProcedure` needing a USER principal,
 * and svc-support is calling on behalf of an operator who is not the account
 * holder. Forwarding the operator's principal would either fail authorization
 * or, worse, require identity to accept "trust me, this is a support person",
 * which is an authority no scope grants.
 *
 * Every failure — transport, 401, 404, unparseable body — becomes `null`, which
 * the caller renders as an explicitly unread grounding. A shape that does not
 * match the published contract is a shape we must not guess at.
 */
export function createAccountStateClient(
  baseUrl: string,
  internalSecret: string,
  /** svc-support's own key. With it the call is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AccountStateSource {
  if (!identitySecretSet(internalSecret)) {
    return {
      async stateOf(): Promise<AccountState | null> {
        throw new IdentityGroundingUnwiredError();
      },
    };
  }

  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async stateOf(userId: string): Promise<AccountState | null> {
      let response: Response;
      try {
        const target = `${url}/internal/account/${encodeURIComponent(userId)}`;
        response = await fetch(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch {
        return null;
      }

      if (!response.ok) return null;

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }

      const parsed = accountStateSchema.safeParse(body);
      if (!parsed.success) return null;
      // Bind the projection to the user we asked about. A misrouted or hostile
      // identity plane that answers with a different userId would otherwise be
      // accepted as grounding for the ticket owner — the same failure
      // svc-agents already refuses as account_owner_mismatch.
      if (parsed.data.userId !== userId) return null;
      return parsed.data;
    },
  };
}

// PROOF ONLY, never merged: a deliberate type error to show the CI annotation.
export const whyRedProof: number = "not a number";
