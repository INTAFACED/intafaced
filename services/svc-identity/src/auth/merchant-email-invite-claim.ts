/**
 * Tell svc-pay that this account just signed in, so a pending email invite
 * for that mailbox can be claimed. Unwired (no pay URL) is a no-op: sign-in
 * still succeeds, and a later sign-in with the URL set claims what is left.
 *
 * The transport ceiling is how long sign-in will wait on pay. It is not an
 * invite lifetime. A refusal or a timeout does not fail the session.
 */
import { serviceAuthHeadersForBody } from '@intafaced/contracts';

export interface MerchantEmailInviteClaim {
  readonly userId: string;
  readonly email: string;
}

export interface MerchantEmailInviteClaimer {
  claim(input: MerchantEmailInviteClaim): Promise<void>;
}

/** How long a sign-in waits for pay before leaving the invite pending. */
const CLAIM_TRANSPORT_MS = 5_000;
const CLAIM_PATH = '/internal/merchant-team/claim-email-invites';

export function createPayMerchantEmailInviteClaimer(
  payUrl: string,
  internalSecret: string,
  fetchImpl: typeof fetch = fetch,
): MerchantEmailInviteClaimer {
  return {
    async claim(input) {
      const body = JSON.stringify({ userId: input.userId, email: input.email });
      const response = await fetchImpl(new URL(CLAIM_PATH, payUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...serviceAuthHeadersForBody('svc-identity', internalSecret, body),
        },
        body,
        signal: AbortSignal.timeout(CLAIM_TRANSPORT_MS),
      });
      if (!response.ok) {
        throw new Error('merchant email invite claim refused');
      }
    },
  };
}
