import type { RecipeName } from '@intafaced/ledger-client';

/**
 * Which calling service may post which recipe, and which `module` that body
 * must carry.
 *
 * Derived from production call sites on this tree (test files, scripts, and
 * comments excluded). Each `cite` is the file that calls `recipes.<name>(`.
 * A service that only builds a ledger client and never posts is not listed.
 *
 * Not granted, on purpose:
 *   · `subAccountTransfer` — `RECIPE_MATRIX` cites svc-identity `router.ts`,
 *     which only mentions the recipe in a comment. Nothing posts it.
 *   · `orderHoldAmend` — svc-trade `qty-up-amend.ts` no longer calls it.
 *   · `marketMakerSeedFund`, listing fee, premium placement
 *     — tests or parked sockets.
 *
 * `feeCharge` is the exception to the recipe's own module. The registry sample
 * uses a caller-chosen module; the live meter defaults that module to `agents`
 * (`meter.ts`, `options.module ?? 'agents'`) and `svc-agents` `index.ts` does
 * not override it. The allowlist requires module `agents`. svc-trade posts it with module `trade`, for a spot fee
 * paid in the platform token (`fee-ifc.ts`).
 */

export interface RecipeGrant {
  readonly module: string;
  /** File that calls `recipes.<name>(`. */
  readonly cite: string;
}

type Grants = Partial<Record<RecipeName, RecipeGrant>>;

/** File that calls `recipes.<name>(`. */
const g = (module: string, cite: string): RecipeGrant => ({ module, cite });

export const LEDGER_POST_ALLOWLIST = {
  'svc-agents': {
    feeCharge: g('agents', 'services/svc-agents/src/metering/meter.ts'),
  },
  'svc-bank': {
    bankTransfer: g('bank', 'services/svc-bank/src/transfers/transfer-service.ts'),
    businessApprovalHold: g('bank', 'services/svc-bank/src/business/business-service.ts'),
    businessApprovalRelease: g('bank', 'services/svc-bank/src/business/business-service.ts'),
    businessApprovalSettle: g('bank', 'services/svc-bank/src/business/business-service.ts'),
    businessPayroll: g('bank', 'services/svc-bank/src/business/business-service.ts'),
    deposit: g('ledger', 'services/svc-bank/src/ramps/ramp-service.ts'),
    earnDeposit: g('bank', 'services/svc-bank/src/earn/earn-service.ts'),
    earnInterest: g('bank', 'services/svc-bank/src/earn/earn-service.ts'),
    earnPoolFund: g('bank', 'services/svc-bank/src/earn/earn-service.ts'),
    earnWithdraw: g('bank', 'services/svc-bank/src/earn/earn-service.ts'),
    loanBadDebt: g('bank', 'services/svc-bank/src/loans/loan-service.ts'),
    loanCollateralLock: g('bank', 'services/svc-bank/src/loans/loan-service.ts'),
    loanCollateralRelease: g('bank', 'services/svc-bank/src/loans/loan-service.ts'),
    loanDraw: g('bank', 'services/svc-bank/src/loans/loan-service.ts'),
    loanLiquidate: g('bank', 'services/svc-bank/src/loans/loan-service.ts'),
    loanRepay: g('bank', 'services/svc-bank/src/loans/loan-service.ts'),
    loanReserveFund: g('bank', 'services/svc-bank/src/loans/loan-service.ts'),
    rewardPay: g('token', 'services/svc-bank/src/cards/card-service.ts'),
    sweepFeesToRewards: g('token', 'services/svc-bank/src/cards/card-service.ts'),
    withdrawHold: g('ledger', 'services/svc-bank/src/cards/card-service.ts'),
    withdrawReverse: g('ledger', 'services/svc-bank/src/cards/card-service.ts'),
    withdrawSettle: g('ledger', 'services/svc-bank/src/cards/card-service.ts'),
  },
  'svc-campaigns': {
    rewardPay: g('token', 'services/svc-campaigns/src/payouts.ts'),
    sweepFeesToRewards: g('token', 'services/svc-campaigns/src/payouts.ts'),
    campaignRewardLock: g('campaigns', 'services/svc-campaigns/src/payouts.ts'),
    campaignRewardUnlock: g('campaigns', 'services/svc-campaigns/src/payouts.ts'),
    campaignRewardForfeit: g('campaigns', 'services/svc-campaigns/src/payouts.ts'),
  },
  'svc-identity': {
    rewardPay: g('token', 'services/svc-identity/src/affiliates/payout-engine.ts'),
    sweepFeesToRewards: g('token', 'services/svc-identity/src/affiliates/payout-engine.ts'),
  },
  'svc-market': {
    marketPurchase: g('market', 'services/svc-market/src/commerce/commerce-service.ts'),
  },
  'svc-mining-pool': {
    rewardPay: g('token', 'services/svc-mining-pool/src/ledger.ts'),
  },
  'svc-ops': {
    staffHoldConfirm: g('ops', 'services/svc-ops/src/staff-holds/desk.ts'),
    staffHoldPlace: g('ops', 'services/svc-ops/src/staff-holds/desk.ts'),
    staffHoldRelease: g('ops', 'services/svc-ops/src/staff-holds/desk.ts'),
  },
  'svc-p2p': {
    escrowLock: g('p2p', 'services/svc-p2p/src/p2p-service.ts'),
    escrowRefund: g('p2p', 'services/svc-p2p/src/p2p-service.ts'),
    escrowRelease: g('p2p', 'services/svc-p2p/src/p2p-service.ts'),
  },
  'svc-pay': {
    chargebackOpen: g('pay', 'services/svc-pay/src/chargeback-ledger.ts'),
    chargebackShortfall: g('pay', 'services/svc-pay/src/chargeback-ledger.ts'),
    chargebackShortfallRecovered: g('pay', 'services/svc-pay/src/chargeback-ledger.ts'),
    chargebackWon: g('pay', 'services/svc-pay/src/chargeback-ledger.ts'),
    deposit: g('ledger', 'services/svc-pay/src/user-money-service.ts'),
    depositReverse: g('ledger', 'services/svc-pay/src/rails/deposit-reorg.ts'),
    fxConversion: g('pay', 'services/svc-pay/src/conversion/service.ts'),
    fxConversionHold: g('pay', 'services/svc-pay/src/conversion/service.ts'),
    fxConversionLateFill: g('pay', 'services/svc-pay/src/conversion/service.ts'),
    fxConversionRelease: g('pay', 'services/svc-pay/src/conversion/service.ts'),
    fxConversionReverse: g('pay', 'services/svc-pay/src/conversion/service.ts'),
    merchantProceedsPayoutHold: g('pay', 'services/svc-pay/src/settlement-ledger.ts'),
    merchantProceedsPayoutReverse: g('pay', 'services/svc-pay/src/settlement-ledger.ts'),
    merchantProceedsPayoutSettle: g('pay', 'services/svc-pay/src/settlement-ledger.ts'),
    merchantSettlement: g('pay', 'services/svc-pay/src/payment-service/settlement.ts'),
    paymentCapture: g('pay', 'services/svc-pay/src/payment-service/lifecycle.ts'),
    paymentRefund: g('pay', 'services/svc-pay/src/payment-service/refunds.ts'),
    paymentRefundReverse: g('pay', 'services/svc-pay/src/payment-service/refunds.ts'),
    withdrawHold: g('ledger', 'services/svc-pay/src/user-money-service.ts'),
    withdrawReverse: g('ledger', 'services/svc-pay/src/user-money-service.ts'),
    withdrawReturned: g('ledger', 'services/svc-pay/src/withdrawals/returns/service.ts'),
    withdrawSettle: g('ledger', 'services/svc-pay/src/user-money-service.ts'),
  },
  'svc-token': {
    burn: g('token', 'services/svc-token/src/token-service.ts'),
    mintEmission: g('token', 'services/svc-token/src/token-service.ts'),
    rewardPay: g('token', 'services/svc-token/src/token-service.ts'),
    stake: g('token', 'services/svc-token/src/token-service.ts'),
    sweepFeesToRewards: g('token', 'services/svc-token/src/token-service.ts'),
    unstake: g('token', 'services/svc-token/src/token-service.ts'),
  },
  'svc-trade': {
    feeCharge: g('trade', 'services/svc-trade/src/spot/fee-ifc.ts'),
    futuresFundingPay: g('trade', 'services/svc-trade/src/futures/funding-settlement.ts'),
    futuresInsuranceTopup: g('trade', 'services/svc-trade/src/admin/insurance-topup.ts'),
    futuresMarginAdd: g('trade', 'services/svc-trade/src/futures/position-service.ts'),
    futuresMarginLock: g('trade', 'services/svc-trade/src/futures/position-service.ts'),
    futuresMarginRelease: g('trade', 'services/svc-trade/src/futures/liquidation-planner.ts'),
    futuresOrderMarginApply: g('trade', 'services/svc-trade/src/futures/matched-orders.ts'),
    futuresOrderMarginHold: g('trade', 'services/svc-trade/src/futures/matched-orders.ts'),
    futuresOrderMarginRelease: g('trade', 'services/svc-trade/src/futures/matched-orders.ts'),
    futuresRealizeLoss: g('trade', 'services/svc-trade/src/futures/liquidation-planner.ts'),
    futuresRealizeProfit: g('trade', 'services/svc-trade/src/futures/close-planner.ts'),
    marketMakerMakerFill: g('trade', 'services/svc-trade/src/otc/settle.ts'),
    marketMakerOrderHold: g('trade', 'services/svc-trade/src/otc/settle.ts'),
    marketMakerOrderHoldRelease: g('trade', 'services/svc-trade/src/mm/seed-market.ts'),
    orderHold: g('trade', 'services/svc-trade/src/otc/settle.ts'),
    orderHoldRelease: g('trade', 'services/svc-trade/src/convert/settle.ts'),
    rewardPay: g('token', 'services/svc-trade/src/copy/fee-share.ts'),
    sweepFeesToRewards: g('token', 'services/svc-trade/src/copy/fee-share.ts'),
    tradeFill: g('trade', 'services/svc-trade/src/spot/trade-service/fills.ts'),
    tradeFillMakerRebate: g('trade', 'services/svc-trade/src/spot/trade-service/fills.ts'),
  },
} as const satisfies Record<string, Grants>;

export type LedgerCallerService = keyof typeof LEDGER_POST_ALLOWLIST;

export const LEDGER_CALLER_SERVICES = Object.keys(LEDGER_POST_ALLOWLIST) as LedgerCallerService[];

export function grantFor(service: string, recipe: RecipeName): RecipeGrant | undefined {
  if (!Object.hasOwn(LEDGER_POST_ALLOWLIST, service)) return undefined;
  const grants = LEDGER_POST_ALLOWLIST[service as LedgerCallerService] as Grants;
  if (!Object.hasOwn(grants, recipe)) return undefined;
  return grants[recipe];
}

export function modulesFor(service: string): ReadonlySet<string> {
  if (!Object.hasOwn(LEDGER_POST_ALLOWLIST, service)) return new Set();
  const grants = LEDGER_POST_ALLOWLIST[service as LedgerCallerService] as Grants;
  return new Set(Object.values(grants).flatMap((grant) => (grant ? [grant.module] : [])));
}
