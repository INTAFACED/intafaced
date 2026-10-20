/**
 * D26-P1-O2 — pay settlement fee → identity affiliate accrue (producer caller).
 *
 * Accrual never moves value. Settlement already posted `merchantSettlement`
 * into `houseFees('pay')`. This port claims commission rows under owner rate law.
 *
 * MUST NOT fail the settlement: 412 unpublished rates and identity-down are
 * swallowed. Never invent rates. Never unwind the ledger post.
 */

import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export const AFFILIATE_PRODUCER_PATH = '/internal/affiliates/accrue';

export type AffiliatePayFeeLeg = {
  readonly userId: string;
  readonly feeAmount: Amount;
  readonly feeAsset: string;
  readonly feeEventId: string;
};

export interface AffiliateAccruePort {
  accruePayFee(leg: AffiliatePayFeeLeg): Promise<void>;
}

export class NoopAffiliateAccrue implements AffiliateAccruePort {
  async accruePayFee(): Promise<void> {
    /* tests / stacks without IDENTITY_URL */
  }
}

export type AffiliateLegAfterPaySettlementInput = {
  readonly settlementId: string;
  readonly merchantUserId: string;
  readonly feeAmount: Amount;
  readonly feeAsset: string;
};

/** Skip zero house fees — nothing to share. */
export function affiliateLegAfterPaySettlement(input: AffiliateLegAfterPaySettlementInput): AffiliatePayFeeLeg[] {
  if (input.feeAmount <= 0n) return [];
  return [
    {
      userId: input.merchantUserId,
      feeAmount: input.feeAmount,
      feeAsset: input.feeAsset,
      feeEventId: `pay.settle:${input.settlementId}`,
    },
  ];
}

/** Awaited after ledger post; never throws (settlement already happened). */
export async function fireAffiliateAccrue(port: AffiliateAccruePort, legs: readonly AffiliatePayFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.accruePayFee(leg);
    } catch {
      /* identity down / 5xx / timeout — do not unwind settlement */
    }
  }
}

const FETCH_MS = 2_000;

export function createAffiliateAccrueClient(
  baseUrl: string,
  internalSecret: string,
  /** svc-pay's own key. With it the call is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AffiliateAccruePort {
  const url = `${baseUrl.replace(/\/$/, '')}${AFFILIATE_PRODUCER_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-pay', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async accruePayFee(leg) {
      const body = JSON.stringify({
        feeEventId: leg.feeEventId,
        userId: leg.userId,
        feeAmount: formatAmount(leg.feeAmount),
        asset: leg.feeAsset,
        sourceModule: 'pay',
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
