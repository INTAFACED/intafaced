import type { RecipeName } from '@intafaced/ledger-client';

/**
 * Which calling service may post which recipe, and which `module` that body
 * must carry.
 *
 * Derived from production call sites on this tree (test files, scripts, and
 * comments excluded). Each `cite` is `path:line` of a `recipes.<name>(` call.
 * A service that only builds a ledger client and never posts is not listed.
 *
 * Not granted, on purpose:
 *   · `subAccountTransfer` — `RECIPE_MATRIX` cites svc-identity `router.ts`,
 *     which only mentions the recipe in a comment. Nothing posts it.
 *   · `marketMakerSeedFund`, insurance top-up, chargeback shortfall/won/
 *     recovered, listing fee, premium placement — tests or parked sockets.
 *   · svc-mining-pool — it can build a client; no production `.post` call.
 *
 * `feeCharge` is the exception to the recipe's own module. The registry sample
 * uses a caller-chosen module; the live meter defaults that module to `agents`
 * (`meter.ts`, `options.module ?? 'agents'`) and `svc-agents` `index.ts` does
 * not override it. The allowlist requires module `agents`.
 */

export interface RecipeGrant {
  readonly module: string;
  readonly cite: string;
}

type Grants = Partial<Record<RecipeName, RecipeGrant>>;

const g = (module: string, cite: string): RecipeGrant => ({ module, cite });

export const LEDGER_POST_ALLOWLIST = {
  'svc-agents': {
    feeCharge: g('agents', 'services/svc-agents/src/metering/meter.ts:352'),
  },
  'svc-bank': {
    bankTransfer: g('bank', 'services/svc-bank/src/transfers/transfer-service.ts:221'),
    businessApprovalHold: g('bank', 'services/svc-bank/src/business/business-service.ts:328'),
    businessApprovalRelease: g('bank', 'services/svc-bank/src/business/business-service.ts:959'),
    businessApprovalSettle: g('bank', 'services/svc-bank/src/business/business-service.ts:901'),
    businessPayroll: g('bank', 'services/svc-bank/src/business/business-service.ts:562'),
    deposit: g('ledger', 'services/svc-bank/src/ramps/ramp-service.ts:286'),
    earnDeposit: g('bank', 'services/svc-bank/src/earn/earn-service.ts:420'),
    earnInterest: g('bank', 'services/svc-bank/src/earn/earn-service.ts:810'),
    earnPoolFund: g('bank', 'services/svc-bank/src/earn/earn-service.ts:242'),
    earnWithdraw: g('bank', 'services/svc-bank/src/earn/earn-service.ts:624'),
    loanBadDebt: g('bank', 'services/svc-bank/src/loans/loan-service.ts:2524'),
    loanCollateralLock: g('bank', 'services/svc-bank/src/loans/loan-service.ts:709'),
    loanCollateralRelease: g('bank', 'services/svc-bank/src/loans/loan-service.ts:1205'),
    loanDraw: g('bank', 'services/svc-bank/src/loans/loan-service.ts:668'),
    loanLiquidate: g('bank', 'services/svc-bank/src/loans/loan-service.ts:2424'),
    loanRepay: g('bank', 'services/svc-bank/src/loans/loan-service.ts:1679'),
    loanReserveFund: g('bank', 'services/svc-bank/src/loans/loan-service.ts:2624'),
    rewardPay: g('token', 'services/svc-bank/src/cards/card-service.ts:1091'),
    sweepFeesToRewards: g('token', 'services/svc-bank/src/cards/card-service.ts:1145'),
    withdrawHold: g('ledger', 'services/svc-bank/src/cards/card-service.ts:577'),
    withdrawReverse: g('ledger', 'services/svc-bank/src/cards/card-service.ts:793'),
    withdrawSettle: g('ledger', 'services/svc-bank/src/cards/card-service.ts:773'),
  },
  'svc-identity': {
    rewardPay: g('token', 'services/svc-identity/src/affiliates/payout-engine.ts:341'),
    sweepFeesToRewards: g('token', 'services/svc-identity/src/affiliates/payout-engine.ts:340'),
  },
  'svc-market': {
    marketPurchase: g('market', 'services/svc-market/src/commerce/commerce-service.ts:555'),
  },
  'svc-p2p': {
    escrowLock: g('p2p', 'services/svc-p2p/src/p2p-service.ts:1348'),
    escrowRefund: g('p2p', 'services/svc-p2p/src/p2p-service.ts:2134'),
    escrowRelease: g('p2p', 'services/svc-p2p/src/p2p-service.ts:2121'),
  },
  'svc-pay': {
    chargebackOpen: g('pay', 'services/svc-pay/src/chargeback-ledger.ts:27'),
    deposit: g('ledger', 'services/svc-pay/src/user-money-service.ts:241'),
    fxConversion: g('pay', 'services/svc-pay/src/conversion/service.ts:1518'),
    fxConversionHold: g('pay', 'services/svc-pay/src/conversion/service.ts:1278'),
    fxConversionLateFill: g('pay', 'services/svc-pay/src/conversion/service.ts:1794'),
    fxConversionRelease: g('pay', 'services/svc-pay/src/conversion/service.ts:644'),
    fxConversionReverse: g('pay', 'services/svc-pay/src/conversion/service.ts:1522'),
    merchantProceedsPayoutHold: g('pay', 'services/svc-pay/src/settlement-ledger.ts:49'),
    merchantProceedsPayoutReverse: g('pay', 'services/svc-pay/src/settlement-ledger.ts:51'),
    merchantProceedsPayoutSettle: g('pay', 'services/svc-pay/src/settlement-ledger.ts:50'),
    merchantSettlement: g('pay', 'services/svc-pay/src/payment-service.ts:3505'),
    paymentCapture: g('pay', 'services/svc-pay/src/payment-service.ts:2477'),
    paymentRefund: g('pay', 'services/svc-pay/src/payment-service.ts:2780'),
    paymentRefundReverse: g('pay', 'services/svc-pay/src/payment-service.ts:2883'),
    withdrawHold: g('ledger', 'services/svc-pay/src/user-money-service.ts:430'),
    withdrawReverse: g('ledger', 'services/svc-pay/src/user-money-service.ts:722'),
    withdrawSettle: g('ledger', 'services/svc-pay/src/user-money-service.ts:537'),
  },
  'svc-token': {
    burn: g('token', 'services/svc-token/src/token-service.ts:1492'),
    mintEmission: g('token', 'services/svc-token/src/token-service.ts:1760'),
    rewardPay: g('token', 'services/svc-token/src/token-service.ts:1107'),
    stake: g('token', 'services/svc-token/src/token-service.ts:443'),
    sweepFeesToRewards: g('token', 'services/svc-token/src/token-service.ts:1073'),
    unstake: g('token', 'services/svc-token/src/token-service.ts:670'),
  },
  'svc-trade': {
    futuresFundingPay: g('trade', 'services/svc-trade/src/futures/funding-settlement.ts:162'),
    futuresMarginAdd: g('trade', 'services/svc-trade/src/futures/position-service.ts:1182'),
    futuresMarginLock: g('trade', 'services/svc-trade/src/futures/position-service.ts:936'),
    futuresMarginRelease: g('trade', 'services/svc-trade/src/futures/liquidation-planner.ts:174'),
    futuresRealizeLoss: g('trade', 'services/svc-trade/src/futures/liquidation-planner.ts:162'),
    futuresRealizeProfit: g('trade', 'services/svc-trade/src/futures/close-planner.ts:85'),
    marketMakerMakerFill: g('trade', 'services/svc-trade/src/otc/settle.ts:61'),
    marketMakerOrderHold: g('trade', 'services/svc-trade/src/otc/settle.ts:56'),
    marketMakerOrderHoldRelease: g('trade', 'services/svc-trade/src/mm/seed-market.ts:267'),
    orderHold: g('trade', 'services/svc-trade/src/otc/settle.ts:50'),
    orderHoldAmend: g('trade', 'services/svc-trade/src/spot/qty-up-amend.ts:89'),
    orderHoldRelease: g('trade', 'services/svc-trade/src/convert/settle.ts:79'),
    rewardPay: g('token', 'services/svc-trade/src/copy/fee-share.ts:173'),
    sweepFeesToRewards: g('token', 'services/svc-trade/src/copy/fee-share.ts:167'),
    tradeFill: g('trade', 'services/svc-trade/src/spot/trade-service.ts:2888'),
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
