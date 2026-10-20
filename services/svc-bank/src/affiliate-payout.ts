/**
 * Loan house fee → identity affiliate payout (producer caller).
 *
 * Accrue already claimed durable rows. This port pays them through
 * identity `POST /internal/affiliates/payout` with `{ feeEventId }` only.
 * Identity plans/posts via ledger-client. Bank never invents rates or amounts.
 *
 * MUST NOT fail the loan post: 412 (unset / unpublished / frozen / nothing
 * accrued) and identity-down are swallowed. Never unwind ledger.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { AffiliateBankFeeLeg } from './affiliate-accrue.js';

export const AFFILIATE_PRODUCER_PAYOUT_PATH = '/internal/affiliates/payout';

export interface AffiliatePayoutPort {
  payoutBankFee(feeEventId: string): Promise<void>;
}

export class NoopAffiliatePayout implements AffiliatePayoutPort {
  async payoutBankFee(): Promise<void> {
    /* tests / stacks without IDENTITY_URL */
  }
}

/** Awaited after accrue; never throws (loan house fee already posted). */
export async function fireAffiliatePayout(port: AffiliatePayoutPort, legs: readonly AffiliateBankFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.payoutBankFee(leg.feeEventId);
    } catch {
      /* identity down / 5xx / timeout — do not unwind ledger */
    }
  }
}

const FETCH_MS = 2_000;

export function createAffiliatePayoutClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AffiliatePayoutPort {
  const url = `${baseUrl.replace(/\/$/, '')}${AFFILIATE_PRODUCER_PAYOUT_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async payoutBankFee(feeEventId) {
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
