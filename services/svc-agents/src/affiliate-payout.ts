/**
 * Usage feeCharge → identity affiliate payout (producer caller).
 *
 * Accrue already claimed durable rows. This port pays them through
 * identity `POST /internal/affiliates/payout` with `{ feeEventId }` only.
 * Identity plans/posts via ledger-client. Agents never invents rates or amounts.
 *
 * MUST NOT fail the charge: 412 (unset / unpublished / frozen / nothing
 * accrued) and identity-down are swallowed. Never unwind the ledger post.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { AffiliateAgentsFeeLeg } from './affiliate-accrue.js';

export const AFFILIATE_PRODUCER_PAYOUT_PATH = '/internal/affiliates/payout';

export interface AffiliatePayoutPort {
  payoutAgentsFee(feeEventId: string): Promise<void>;
}

export class NoopAffiliatePayout implements AffiliatePayoutPort {
  async payoutAgentsFee(): Promise<void> {
    /* tests / stacks without IDENTITY_URL */
  }
}

/** Awaited after accrue; never throws (feeCharge already happened). */
export async function fireAffiliatePayout(port: AffiliatePayoutPort, legs: readonly AffiliateAgentsFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.payoutAgentsFee(leg.feeEventId);
    } catch {
      /* identity down / 5xx / timeout — do not unwind feeCharge */
    }
  }
}

const FETCH_MS = 2_000;

export function createAffiliatePayoutClient(
  baseUrl: string,
  internalSecret: string,
  /** svc-agents' own key. With it the call is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AffiliatePayoutPort {
  const url = `${baseUrl.replace(/\/$/, '')}${AFFILIATE_PRODUCER_PAYOUT_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-agents', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async payoutAgentsFee(feeEventId) {
      const body = JSON.stringify({ feeEventId });
      const headers = {
        'content-type': 'application/json',
        ...sign(body, { method: 'POST', url: new URL(url), contentType: 'application/json' }),
      };
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (response.ok) return;
      if (response.status === 412) return;
      throw new Error(`affiliate payout refused (${response.status})`);
    },
  };
}
