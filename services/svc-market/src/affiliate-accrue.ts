/**
 * market.commerce purchase → identity affiliate accrue (producer caller).
 *
 * Accrual never moves value. Purchase already posted `marketPurchase`
 * into `houseFees('market')`. This port claims commission rows under owner rate law.
 *
 * MUST NOT fail the purchase: 412 unpublished rates and identity-down are
 * swallowed. Never invent rates. Never unwind the ledger post.
 */

import { formatAmount, mulBps, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export const AFFILIATE_PRODUCER_PATH = '/internal/affiliates/accrue';

export type AffiliateMarketFeeLeg = {
  readonly userId: string;
  readonly feeAmount: Amount;
  readonly feeAsset: string;
  readonly feeEventId: string;
};

export interface AffiliateAccruePort {
  accrueMarketFee(leg: AffiliateMarketFeeLeg): Promise<void>;
}

export class NoopAffiliateAccrue implements AffiliateAccruePort {
  async accrueMarketFee(): Promise<void> {
    /* tests / stacks without IDENTITY_URL */
  }
}

export type AffiliateLegAfterMarketPurchaseInput = {
  readonly purchaseId: string;
  readonly vendorUserId: string;
  readonly snapshotPrice: Amount;
  readonly snapshotBps: number;
  readonly feeAsset: string;
};

/** Skip zero house fees — nothing to share. Floor matches recipes.marketPurchase. */
export function affiliateLegAfterMarketPurchase(input: AffiliateLegAfterMarketPurchaseInput): AffiliateMarketFeeLeg[] {
  const feeAmount = mulBps(input.snapshotPrice, input.snapshotBps, 'floor');
  if (feeAmount <= 0n) return [];
  return [
    {
      userId: input.vendorUserId,
      feeAmount,
      feeAsset: input.feeAsset,
      feeEventId: `market.purchase:${input.purchaseId}`,
    },
  ];
}

/** Awaited after ledger post; never throws (purchase already posted). */
export async function fireAffiliateAccrue(port: AffiliateAccruePort, legs: readonly AffiliateMarketFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.accrueMarketFee(leg);
    } catch {
      /* identity down / 5xx / timeout — do not unwind marketPurchase */
    }
  }
}

const FETCH_MS = 2_000;

export function createAffiliateAccrueClient(
  baseUrl: string,
  internalSecret: string,
  /** svc-market's own key. With it the call is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AffiliateAccruePort {
  const url = `${baseUrl.replace(/\/$/, '')}${AFFILIATE_PRODUCER_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-market', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async accrueMarketFee(leg) {
      const body = JSON.stringify({
        feeEventId: leg.feeEventId,
        userId: leg.userId,
        feeAmount: formatAmount(leg.feeAmount),
        asset: leg.feeAsset,
        sourceModule: 'market',
      });
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
      throw new Error(`affiliate accrue refused (${response.status})`);
    },
  };
}
