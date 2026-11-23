import type { BankRoot } from '../bank-root.js';
import type { PartnerCustody, PostingFreeze } from './partner-bank.js';
import type { PartnerPurchaseCustody } from './partner-purchases.js';
import type { PartnerRefusalCounts } from './partner-refusals.js';
import type { PartnerStopService } from './partner-stops.js';
import { testPartnerPurchases, type TestPartnerDoors } from './test-partner.js';
import { NO_CASH_LEGS, testPartnerCashLegs, type CashLegPayout, type CashLegRate, type CashLegs } from './cash-leg.js';

/** The partner bank as the rest of svc-bank and the desk read it. An area of svc-bank (`area-chain.ts`). */
export interface PartnerServices {
  /** The TEST partner bank and ramp with their switches (CUSTODY-DELTA §4), on a dev or test stack only; null elsewhere. */
  readonly testPartner: TestPartnerDoors | null;
  /** Who holds each person's bank money: the partner, or (null) the custodial layer. */
  readonly partnerCustody: PartnerCustody;
  /** Who credits a partner-held person's purchase and reports what it holds back of it (J-wallet-01 #3). */
  readonly partnerPurchases: PartnerPurchaseCustody;
  /** svc-ledger's posting freeze as svc-bank reads it, for the desk. */
  readonly postingFreeze: PostingFreeze;
  /** The operator's partner stop (project-state #1790): one partner, or one kind of instruction, without the posting freeze. */
  readonly partnerStops: PartnerStopService;
  /** What the posting freeze and the partner stop refused, by day, cause and kind (project-state #1790). */
  readonly partnerRefusals: PartnerRefusalCounts;
  /** The partner's cash leg of a cash-through-a-coin convert (J-cex-spot-11 #11): none offered unless the TEST partner gives one. */
  readonly cashLegs: CashLegs;
}

export interface PartnerServiceOptions {
  /** LOCAL TEST: the TEST partner's cash-leg rates and its payout into the TEST venue; both, with the TEST partner, or none. */
  readonly testCashLeg?: { readonly rates: readonly CashLegRate[]; readonly payout: CashLegPayout } | null;
}

export function composePartnerArea(root: BankRoot, _made: object, options: PartnerServiceOptions): PartnerServices {
  return {
    testPartner: root.testPartner,
    partnerCustody: root.custody,
    // A person the TEST partner holds money for has their paid purchase credited by the partner itself, not the ledger.
    partnerPurchases: testPartnerPurchases(root.testPartner),
    postingFreeze: root.postingFreeze,
    partnerStops: root.partnerStops,
    partnerRefusals: root.partnerRefusals,
    cashLegs:
      root.testPartner && options.testCashLeg
        ? testPartnerCashLegs({
            partner: root.testPartner,
            custody: root.custody,
            custodyLayer: root.custodyLayer,
            rates: options.testCashLeg.rates,
            payout: options.testCashLeg.payout,
          })
        : NO_CASH_LEGS,
  };
}
