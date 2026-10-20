/**
 * P2P escrow release fee → identity affiliate accrue (producer caller).
 *
 * Accrual never moves value. Release already posted `escrowRelease` into
 * `houseFees('p2p')`. This port claims commission rows under owner rate law.
 *
 * MUST NOT fail the release: 412 unpublished rates and identity-down are
 * swallowed. Never invent rates. Never unwind the ledger post.
 */

import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export const AFFILIATE_PRODUCER_PATH = '/internal/affiliates/accrue';

export type AffiliateP2pFeeLeg = {
  readonly userId: string;
  readonly feeAmount: Amount;
  readonly feeAsset: string;
  readonly feeEventId: string;
};

export interface AffiliateAccruePort {
  accrueP2pFee(leg: AffiliateP2pFeeLeg): Promise<void>;
}

export class NoopAffiliateAccrue implements AffiliateAccruePort {
  async accrueP2pFee(): Promise<void> {
    /* tests / stacks without IDENTITY_URL */
  }
}

export type AffiliateLegAfterP2pReleaseInput = {
  readonly tradeId: string;
  readonly sellerId: string;
  readonly feeAmount: Amount;
  readonly feeAsset: string;
};

/** Skip zero house fees — nothing to share. Refund / void never reach here with a fee. */
export function affiliateLegAfterP2pRelease(input: AffiliateLegAfterP2pReleaseInput): AffiliateP2pFeeLeg[] {
  if (input.feeAmount <= 0n) return [];
  return [
    {
      userId: input.sellerId,
      feeAmount: input.feeAmount,
      feeAsset: input.feeAsset,
      feeEventId: `p2p.release:${input.tradeId}`,
    },
  ];
}

/** Awaited after ledger post; never throws (escrowRelease already happened). */
export async function fireAffiliateAccrue(port: AffiliateAccruePort, legs: readonly AffiliateP2pFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.accrueP2pFee(leg);
    } catch {
      /* identity down / 5xx / timeout — do not unwind escrowRelease */
    }
  }
}

const FETCH_MS = 2_000;

export function createAffiliateAccrueClient(
  baseUrl: string,
  internalSecret: string,
  /** svc-p2p's own key. With it the call is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): AffiliateAccruePort {
  const url = `${baseUrl.replace(/\/$/, '')}${AFFILIATE_PRODUCER_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-p2p', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async accrueP2pFee(leg) {
      const body = JSON.stringify({
        feeEventId: leg.feeEventId,
        userId: leg.userId,
        feeAmount: formatAmount(leg.feeAmount),
        asset: leg.feeAsset,
        sourceModule: 'p2p',
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
