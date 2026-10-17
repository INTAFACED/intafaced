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
 *   · `marketMakerSeedFund`, insurance top-up, listing fee, premium placement
 *     — tests or parked sockets.
 *   · svc-mining-pool — it can build a client; no production `recipes.` call.
 *
 * `feeCharge` is the exception to the recipe's own module. The registry sample
 * uses a caller-chosen module; the live meter defaults that module to `agents`
 * (`meter.ts`, `options.module ?? 'agents'`) and `svc-agents` `index.ts` does
 * not override it. The allowlist requires module `agents`.
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
  'svc-identity': {
    rewardPay: g('token', 'services/svc-identity/src/affiliates/payout-engine.ts'),
    sweepFeesToRewards: g('token', 'services/svc-identity/src/affiliates/payout-engine.ts'),
  },
  'svc-market': {
    marketPurchase: g('market', 'services/svc-market/src/commerce/commerce-service.ts'),
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
    merchantSettlement: g('pay', 'services/svc-pay/src/payment-service.ts'),
    paymentCapture: g('pay', 'services/svc-pay/src/payment-service.ts'),
    paymentRefund: g('pay', 'services/svc-pay/src/payment-service.ts'),
    paymentRefundReverse: g('pay', 'services/svc-pay/src/payment-service.ts'),
    withdrawHold: g('ledger', 'services/svc-pay/src/user-money-service.ts'),
    withdrawReverse: g('ledger', 'services/svc-pay/src/user-money-service.ts'),
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
    futuresFundingPay: g('trade', 'services/svc-trade/src/futures/funding-settlement.ts'),
    futuresMarginAdd: g('trade', 'services/svc-trade/src/futures/position-service.ts'),
    futuresMarginLock: g('trade', 'services/svc-trade/src/futures/position-service.ts'),
    futuresMarginRelease: g('trade', 'services/svc-trade/src/futures/liquidation-planner.ts'),
    futuresRealizeLoss: g('trade', 'services/svc-trade/src/futures/liquidation-planner.ts'),
    futuresRealizeProfit: g('trade', 'services/svc-trade/src/futures/close-planner.ts'),
    marketMakerMakerFill: g('trade', 'services/svc-trade/src/otc/settle.ts'),
    marketMakerOrderHold: g('trade', 'services/svc-trade/src/otc/settle.ts'),
    marketMakerOrderHoldRelease: g('trade', 'services/svc-trade/src/mm/seed-market.ts'),
    orderHold: g('trade', 'services/svc-trade/src/otc/settle.ts'),
    orderHoldRelease: g('trade', 'services/svc-trade/src/convert/settle.ts'),
    rewardPay: g('token', 'services/svc-trade/src/copy/fee-share.ts'),
    sweepFeesToRewards: g('token', 'services/svc-trade/src/copy/fee-share.ts'),
    tradeFill: g('trade', 'services/svc-trade/src/spot/trade-service.ts'),
  },
} as const satisfies Record<string, Grants>;

export type LedgerCallerService = keyof typeof LEDGER_POST_ALLOWLIST;

export const LEDGER_CALLER_SERVICES = Object.keys(LEDGER_POST_ALLOWLIST) as LedgerCallerService[];

/** `svc-pay` → `LEDGER_CALLER_SECRET_SVC_PAY`. The env name is the key id. */
export function callerSecretEnvName(service: string): string {
  return `LEDGER_CALLER_SECRET_${service.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Dedicated-secret env names, as a tuple so each field stays typed on the
 * ledger env object. The test checks this list against `LEDGER_CALLER_SERVICES`.
 */
export const CALLER_SECRET_ENV_NAMES = [
  'LEDGER_CALLER_SECRET_SVC_AGENTS',
  'LEDGER_CALLER_SECRET_SVC_BANK',
  'LEDGER_CALLER_SECRET_SVC_IDENTITY',
  'LEDGER_CALLER_SECRET_SVC_MARKET',
  'LEDGER_CALLER_SECRET_SVC_P2P',
  'LEDGER_CALLER_SECRET_SVC_PAY',
  'LEDGER_CALLER_SECRET_SVC_TOKEN',
  'LEDGER_CALLER_SECRET_SVC_TRADE',
] as const;

export type CallerSecretEnvName = (typeof CALLER_SECRET_ENV_NAMES)[number];

/**
 * A dedicated secret that copies `INTERNAL_SERVICE_SECRET`, or another
 * service's secret, makes the binding meaningless. Refuse boot. The message
 * names the env var and never the value.
 */
export function assertDistinctCallerSecrets(namedSecrets: readonly (readonly [string, string])[], sharedSecret: string): void {
  const shared = sharedSecret.trim();
  const seen = new Map<string, string>();
  for (const [envName, raw] of namedSecrets) {
    if (typeof raw !== 'string') continue;
    const secret = raw.trim();
    if (secret.length === 0) continue;
    if (secret === shared) {
      throw new Error(`${envName} must not equal INTERNAL_SERVICE_SECRET`);
    }
    const prior = seen.get(secret);
    if (prior !== undefined) {
      throw new Error(`${envName} must not equal ${prior}`);
    }
    seen.set(secret, envName);
  }
}

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
