/**
 * Loan house fee → identity affiliate accrue (producer caller).
 *
 * Accrual never moves value. loanRepay / loanLiquidate already posted into
 * `houseFees('bank')`. This port claims commission rows under owner rate law.
 *
 * MUST NOT fail the loan post: 412 unpublished rates and identity-down are
 * swallowed. Never invent rates. Never unwind the ledger post.
 */

import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export const AFFILIATE_PRODUCER_PATH = '/internal/affiliates/accrue';

export type AffiliateBankFeeLeg = {
  readonly userId: string;
  readonly feeAmount: Amount;
  readonly feeAsset: string;
  readonly feeEventId: string;
};

export interface AffiliateAccruePort {
  accrueBankFee(leg: AffiliateBankFeeLeg): Promise<void>;
}

export class NoopAffiliateAccrue implements AffiliateAccruePort {
  async accrueBankFee(): Promise<void> {
    /* tests / stacks without IDENTITY_URL */
  }
}

export type AffiliateLegAfterLoanRepayInput = {
  readonly loanId: string;
  readonly borrowerId: string;
  readonly sequence: number;
  readonly interest: Amount;
  readonly debtAssetId: string;
};

export type AffiliateLegAfterLoanLiquidateInput = {
  readonly loanId: string;
  readonly borrowerId: string;
  readonly tranche: number;
  readonly interestRepaid: Amount;
  readonly penalty: Amount;
  readonly debtAssetId: string;
};

/** Skip zero interest — principal repay is not house revenue. */
export function affiliateLegAfterLoanRepay(input: AffiliateLegAfterLoanRepayInput): AffiliateBankFeeLeg[] {
  if (input.interest <= 0n) return [];
  return [
    {
      userId: input.borrowerId,
      feeAmount: input.interest,
      feeAsset: input.debtAssetId,
      feeEventId: `bank.repay:${input.loanId}:${input.sequence}`,
    },
  ];
}

/** Skip zero house cut — principal repaid is not houseFees('bank'). */
export function affiliateLegAfterLoanLiquidate(input: AffiliateLegAfterLoanLiquidateInput): AffiliateBankFeeLeg[] {
  const houseCut = input.interestRepaid + input.penalty;
  if (houseCut <= 0n) return [];
  return [
    {
      userId: input.borrowerId,
      feeAmount: houseCut,
      feeAsset: input.debtAssetId,
      feeEventId: `bank.liquidate:${input.loanId}:${input.tranche}`,
    },
  ];
}

/** Awaited after ledger post; never throws (loanRepay / loanLiquidate already happened). */
export async function fireAffiliateAccrue(port: AffiliateAccruePort, legs: readonly AffiliateBankFeeLeg[]): Promise<void> {
  for (const leg of legs) {
    try {
      await port.accrueBankFee(leg);
    } catch {
      /* identity down / 5xx / timeout — do not unwind ledger */
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
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  return {
    async accrueBankFee(leg) {
      const body = JSON.stringify({
        feeEventId: leg.feeEventId,
        userId: leg.userId,
        feeAmount: formatAmount(leg.feeAmount),
        asset: leg.feeAsset,
        sourceModule: 'bank',
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
