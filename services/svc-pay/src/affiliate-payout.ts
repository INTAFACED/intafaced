/**
 * Pay settlement → identity affiliate payout (producer caller).
 *
 * Accrue already claimed durable rows. This port pays them through
 * identity `POST /internal/affiliates/payout` with `{ feeEventId }` only.
 * Identity plans/posts via ledger-client. Pay never invents rates or amounts.
 *
 * MUST NOT fail the settlement: 412 (unset / unpublished / frozen / nothing
 * accrued) and identity-down are swallowed. Never unwind the ledger post.
 */

import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import type { AffiliatePayFeeLeg } from './affiliate-accrue.js';

export const AFFILIATE_PRODUCER_PAYOUT_PATH = '/internal/affiliates/payout';

export interface AffiliatePayoutPort {
  payoutPayFee(feeEventId: string): Promise<void>;
}

export class NoopAffiliatePayout implements AffiliatePayoutPort {
  async payoutPayFee(): Promise<void> {
    /* tests / stacks without IDENTITY_URL */
  }
}

/** Awaited after accrue; never throws (settlement already happened). */
export async function fireAffiliatePayout(port: AffiliatePayoutPort, legs: readonly AffiliatePayFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.payoutPayFee(leg.feeEventId);
    } catch {
      /* identity down / 5xx / timeout — do not unwind settlement */
    }
  }
}

const FETCH_MS = 2_000;

export function createAffiliatePayoutClient(baseUrl: string, internalSecret: string): AffiliatePayoutPort {
  const url = `${baseUrl.replace(/\/$/, '')}${AFFILIATE_PRODUCER_PAYOUT_PATH}`;

  return {
    async payoutPayFee(feeEventId) {
      const body = JSON.stringify({ feeEventId });
      const headers = {
        'content-type': 'application/json',
        ...serviceAuthHeadersForBody('svc-pay', internalSecret, body),
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
