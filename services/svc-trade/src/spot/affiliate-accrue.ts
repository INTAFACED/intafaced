/**
 * D26-P1-O2 — trade fill → identity affiliate accrue (producer caller).
 *
 * Accrual never moves value (identity store only). Fill already posted
 * `tradeFill` / `marketMakerMakerFill` into `houseFees('trade')`. This port
 * claims commission rows under owner rate law.
 *
 * MUST NOT fail the fill: rank-perks law is that the fill path settles even
 * when svc-identity is down. 412 `affiliate.accrual.rates_unset` is honest
 * skip, not a retry of the ledger post. Never invent rates.
 */

import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export const AFFILIATE_PRODUCER_PATH = '/internal/affiliates/accrue';

export type AffiliateFeeLeg = {
  readonly userId: string;
  readonly feeAmount: Amount;
  readonly feeAsset: string;
  readonly feeEventId: string;
};

export interface AffiliateAccruePort {
  accrueTradeFee(leg: AffiliateFeeLeg): Promise<void>;
}

export class NoopAffiliateAccrue implements AffiliateAccruePort {
  async accrueTradeFee(): Promise<void> {
    /* tests / stacks without a producer wire */
  }
}

export type AffiliateLegsAfterFillInput = {
  readonly fillId: string;
  readonly makerUserId: string;
  readonly takerUserId: string;
  readonly makerFee: Amount;
  readonly takerFee: Amount;
  readonly makerFeeAsset: string;
  readonly takerFeeAsset: string;
  readonly houseMmUserId: string;
};

/** One identity fee-event per paying user-side. Skip zero fees and house MM. */
export function affiliateLegsAfterFill(input: AffiliateLegsAfterFillInput): AffiliateFeeLeg[] {
  const legs: AffiliateFeeLeg[] = [];
  if (input.makerFee > 0n && input.makerUserId !== input.houseMmUserId) {
    legs.push({
      userId: input.makerUserId,
      feeAmount: input.makerFee,
      feeAsset: input.makerFeeAsset,
      feeEventId: `${input.fillId}:maker`,
    });
  }
  if (input.takerFee > 0n && input.takerUserId !== input.houseMmUserId) {
    legs.push({
      userId: input.takerUserId,
      feeAmount: input.takerFee,
      feeAsset: input.takerFeeAsset,
      feeEventId: `${input.fillId}:taker`,
    });
  }
  return legs;
}

/** Awaited after ledger post; never throws (fill already happened). */
export async function fireAffiliateAccrue(port: AffiliateAccruePort, legs: readonly AffiliateFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.accrueTradeFee(leg);
    } catch {
      /* identity down / 5xx / timeout — do not unwind the fill */
    }
  }
}

const FETCH_MS = 2_000;

export function createAffiliateAccrueClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AffiliateAccruePort {
  const url = `${baseUrl.replace(/\/$/, '')}${AFFILIATE_PRODUCER_PATH}`;
  const authHeaders = serviceCallSigner({ service: 'svc-trade', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async accrueTradeFee(leg) {
      const body = JSON.stringify({
        feeEventId: leg.feeEventId,
        userId: leg.userId,
        feeAmount: formatAmount(leg.feeAmount),
        asset: leg.feeAsset,
        sourceModule: 'trade',
      });
      const headers = {
        'content-type': 'application/json',
        ...authHeaders(body, { method: 'POST', url: new URL(url), contentType: 'application/json' }),
      };
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (response.ok) return;
      // Unpublished owner rates — honest; fill already posted house fees.
      if (response.status === 412) return;
      throw new Error(`affiliate accrue refused (${response.status})`);
    },
  };
}
