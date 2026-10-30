/**
 * D26-P2-11 — Ledger recipe matrix closed for live paths.
 *
 * Done bar: every money path → named recipe or explicit §13.
 *
 * The registry (`export const recipes`) is the product surface. This module is
 * the inventory a test can execute: every registry key is partitioned into
 * `live` (a production service posts it) or `socket` (deliberate §13 — recipe
 * exists so the path can be honest later; nothing wires it today).
 *
 * Do not invent recipes here. Add a row only when the registry already has the
 * function, and classify it from evidence (service call site or named socket).
 */

import { recipes, type RecipeName } from './index.js';

/** How a registry recipe is accounted for against live money paths. */
export type RecipeDisposition =
  | {
      readonly kind: 'live';
      /** Owning module label (matches RECIPES.md Module column). */
      readonly module: string;
      /** One production call-site path (services/…), for review. */
      readonly proof: string;
    }
  | {
      readonly kind: 'socket';
      /** Always §13 — deliberate not-in-v1 / parked wire. */
      readonly socket: '§13';
      readonly reason: string;
    };

/**
 * Closed matrix: every `RecipeName` appears exactly once.
 *
 * Live proofs are the first production (non-test) call site found on tip when
 * this inventory landed. Socket reasons cite the ADR / park that keeps them
 * unwired — not a ticket to invent a caller.
 */
export const RECIPE_MATRIX = {
  deposit: { kind: 'live', module: 'ledger', proof: 'services/svc-pay/src/user-money-service.ts' },
  depositReverse: { kind: 'live', module: 'ledger', proof: 'services/svc-pay/src/rails/deposit-reorg.ts' },
  marketMakerSeedFund: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — recipe funds the house MM pot from a named rail; trade.mm-bot seed jobs consume a pre-funded pot and do not post this. Ops/treasury seed door is not a service writer on tip (package + test seed only).',
  },
  withdrawHold: { kind: 'live', module: 'ledger', proof: 'services/svc-pay/src/user-money-service.ts' },
  withdrawSettle: { kind: 'live', module: 'ledger', proof: 'services/svc-pay/src/user-money-service.ts' },
  withdrawReverse: { kind: 'live', module: 'ledger', proof: 'services/svc-pay/src/user-money-service.ts' },
  withdrawReturned: { kind: 'live', module: 'ledger', proof: 'services/svc-pay/src/withdrawals/returns/service.ts' },
  tradeFill: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/spot/trade-service/fills.ts' },
  tradeFillFeeCorrection: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — TRD-0171 posts a fee correction as a new balanced entry under trade.fill.fee.correction. It leaves the original trade.fill row. No production writer posts this yet; the recipe-gate catalog samples it and does not ledger.post.',
  },
  tradeFillMakerRebate: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/spot/trade-service/fills.ts' },
  orderHold: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/spot/trade-service/order-place.ts' },
  orderHoldRelease: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/spot/trade-service/holds.ts' },
  orderHoldAmend: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — qty-up extra hold on the orderHold pot. svc-trade native amend only reduces remaining quantity and refuses trade.amend_qty_up, so qty-up-amend.ts no longer posts this. The recipe-gate catalog samples it and does not ledger.post. No production writer on tip.',
  },
  marketMakerOrderHold: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/mm/seed-market.ts' },
  marketMakerOrderHoldRelease: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/mm/seed-market.ts' },
  marketMakerMakerFill: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/spot/trade-service/fills.ts' },
  futuresMarginLock: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/position-service.ts' },
  futuresMarginAdd: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/position-service.ts' },
  futuresMarginRelease: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/close-planner.ts' },
  futuresOrderMarginHold: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/matched-orders.ts' },
  futuresOrderMarginRelease: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/matched-orders.ts' },
  futuresOrderMarginApply: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/matched-orders.ts' },
  futuresRealizeLoss: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/liquidation-planner.ts' },
  futuresRealizeProfit: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/close-planner.ts' },
  futuresFundingPay: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/futures/funding-settlement.ts' },
  futuresInsuranceTopup: { kind: 'live', module: 'trade', proof: 'services/svc-trade/src/admin/insurance-topup.ts' },
  escrowLock: { kind: 'live', module: 'p2p', proof: 'services/svc-p2p/src/p2p-service.ts' },
  escrowRelease: { kind: 'live', module: 'p2p', proof: 'services/svc-p2p/src/p2p-service.ts' },
  escrowRefund: { kind: 'live', module: 'p2p', proof: 'services/svc-p2p/src/p2p-service.ts' },
  paymentCapture: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/payment-service/lifecycle.ts' },
  merchantSettlement: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/payment-service/settlement.ts' },
  paymentRefund: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/payment-service/refunds.ts' },
  paymentRefundReverse: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/payment-service/refunds.ts' },
  merchantProceedsPayoutHold: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/settlement-ledger.ts' },
  merchantProceedsPayoutSettle: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/settlement-ledger.ts' },
  merchantProceedsPayoutReverse: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/settlement-ledger.ts' },
  fxConversion: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/conversion/service.ts' },
  fxConversionHold: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/conversion/service.ts' },
  fxConversionRelease: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/conversion/service.ts' },
  fxConversionReverse: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/conversion/service.ts' },
  fxConversionLateFill: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/conversion/service.ts' },
  chargebackOpen: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/chargeback-ledger.ts' },
  chargebackShortfall: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/chargeback-ledger.ts' },
  chargebackWon: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/chargeback-ledger.ts' },
  chargebackShortfallRecovered: { kind: 'live', module: 'pay', proof: 'services/svc-pay/src/chargeback-ledger.ts' },
  stake: { kind: 'live', module: 'token', proof: 'services/svc-token/src/token-service.ts' },
  unstake: { kind: 'live', module: 'token', proof: 'services/svc-token/src/token-service.ts' },
  mintEmission: { kind: 'live', module: 'token', proof: 'services/svc-token/src/token-service.ts' },
  burn: { kind: 'live', module: 'token', proof: 'services/svc-token/src/token-service.ts' },
  feeCharge: { kind: 'live', module: 'token', proof: 'services/svc-agents/src/metering/meter.ts' },
  sweepFeesToRewards: { kind: 'live', module: 'token', proof: 'services/svc-token/src/token-service.ts' },
  rewardPay: { kind: 'live', module: 'token', proof: 'services/svc-token/src/token-service.ts' },
  loanCollateralLock: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/loans/loan-service.ts' },
  loanCollateralRelease: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/loans/loan-service.ts' },
  loanDraw: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/loans/loan-service.ts' },
  loanRepay: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/loans/loan-service.ts' },
  loanLiquidate: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/loans/loan-service.ts' },
  loanBadDebt: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/loans/loan-service.ts' },
  loanReserveFund: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/loans/loan-service.ts' },
  bankTransfer: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/transfers/transfer-service.ts' },
  earnDeposit: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/earn/earn-service.ts' },
  earnWithdraw: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/earn/earn-service.ts' },
  earnPoolFund: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/earn/earn-service.ts' },
  earnInterest: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/earn/earn-service.ts' },
  businessApprovalHold: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/business/business-service.ts' },
  businessApprovalRelease: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/business/business-service.ts' },
  businessApprovalSettle: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/business/business-service.ts' },
  businessPayroll: { kind: 'live', module: 'bank', proof: 'services/svc-bank/src/business/business-service.ts' },
  subAccountTransfer: { kind: 'live', module: 'identity', proof: 'services/svc-identity/src/router.ts' },
  payReceivedHold: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — holds on received funds (pay ENGINE-SPEC RH-1 to RH-4, PP-money-balance-05): recipient available into a pot of its own per hold. svc-bank has no production writer until PP-money-balance-05 lands and no grant is added yet; the recipe-gate catalog samples it and does not ledger.post.',
  },
  payReceivedRelease: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — holds on received funds (pay ENGINE-SPEC RH-1 to RH-4, PP-money-balance-05): held funds back to the recipient at the release date or early by an agent. svc-bank has no production writer until PP-money-balance-05 lands and no grant is added yet; the recipe-gate catalog samples it and does not ledger.post.',
  },
  payReceivedReturn: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — holds on received funds (pay ENGINE-SPEC RH-1 to RH-4, PP-money-balance-05): held funds to the payer on a ruling. svc-bank has no production writer until PP-money-balance-05 lands and no grant is added yet; the recipe-gate catalog samples it and does not ledger.post.',
  },
  bankTransferReversal: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — consented reversal of a posted internal send (bank-transfers BK-xfer-09): recipient available back to the original sender, only with the recipient consent. svc-bank has no production writer until BK-xfer-09 lands and no grant is added yet; the recipe-gate catalog samples it and does not ledger.post.',
  },
  staffHoldPlace: { kind: 'live', module: 'ops', proof: 'services/svc-ops/src/staff-holds/desk.ts' },
  staffHoldRelease: { kind: 'live', module: 'ops', proof: 'services/svc-ops/src/staff-holds/desk.ts' },
  staffHoldConfirm: { kind: 'live', module: 'ops', proof: 'services/svc-ops/src/staff-holds/desk.ts' },
  campaignRewardLock: { kind: 'live', module: 'campaigns', proof: 'services/svc-campaigns/src/payouts.ts' },
  campaignRewardUnlock: { kind: 'live', module: 'campaigns', proof: 'services/svc-campaigns/src/payouts.ts' },
  campaignRewardForfeit: { kind: 'live', module: 'campaigns', proof: 'services/svc-campaigns/src/payouts.ts' },
  marketPurchase: { kind: 'live', module: 'market', proof: 'services/svc-market/src/commerce/commerce-service.ts' },
  marketListingFee: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — D26-P1-M2 vendor listing fee recipe; amount required (no invent rates). Deliberately unwired from svc-market: VendorService moves no value; commerce listing writer is M1 residual.',
  },
  marketPremiumPlacement: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 — D26-P1-M2 premium placement fee recipe; amount required (no invent rates). Ranking/featured order stays owner residual; no svc-market writer posts this on tip.',
  },
  marketPurchaseHold: { kind: 'live', module: 'market', proof: 'services/svc-market/src/commerce/held-purchase.ts' },
  marketPurchaseRefund: { kind: 'live', module: 'market', proof: 'services/svc-market/src/commerce/held-purchase.ts' },
  marketPurchaseRelease: { kind: 'live', module: 'market', proof: 'services/svc-market/src/commerce/held-purchase.ts' },
  buybackOrderHold: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 J-dex-protocol-17 buyback IOC order hold from the rewards engine; svc-trade wires it in the next PR (recipes land first, one package per PR).',
  },
  buybackOrderHoldRelease: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 J-dex-protocol-17 unfilled remainder of a buyback IOC order back to the rewards engine; svc-trade wires it in the next PR.',
  },
  buybackTakerFill: {
    kind: 'socket',
    socket: '§13',
    reason:
      '§13 J-dex-protocol-17 buyback IOC fill against a customer ask, bought base into the rewards engine; svc-trade wires it in the next PR.',
  },
} as const satisfies Record<RecipeName, RecipeDisposition>;

export type MatrixRecipeName = keyof typeof RECIPE_MATRIX;

export interface RecipeMatrixRow {
  readonly name: RecipeName;
  readonly disposition: RecipeDisposition;
}

export interface RecipeMatrixInventory {
  /** Registry keys, sorted. */
  readonly recipes: readonly RecipeName[];
  /** One row per registry recipe. */
  readonly rows: readonly RecipeMatrixRow[];
  readonly live: readonly RecipeName[];
  readonly sockets: readonly RecipeName[];
  /**
   * Registry keys missing from RECIPE_MATRIX, or matrix keys missing from the
   * registry — either is a broken promise (matrix lied).
   */
  readonly brokenPromises: readonly string[];
}

/**
 * Build the closed live-path inventory from the registry + RECIPE_MATRIX.
 * Pure data — no filesystem. Safe to call from unit tests.
 */
export function buildRecipeMatrixInventory(): RecipeMatrixInventory {
  const registry = Object.keys(recipes) as RecipeName[];
  const matrixKeys = Object.keys(RECIPE_MATRIX) as RecipeName[];
  const registrySet = new Set<string>(registry);
  const matrixSet = new Set<string>(matrixKeys);

  const brokenPromises = [
    ...registry.filter((name) => !matrixSet.has(name)).map((name) => `registry-without-matrix:${name}`),
    ...matrixKeys.filter((name) => !registrySet.has(name)).map((name) => `matrix-without-registry:${name}`),
  ].sort();

  const rows: RecipeMatrixRow[] = registry
    .slice()
    .sort()
    .map((name) => ({
      name,
      disposition: RECIPE_MATRIX[name] as RecipeDisposition,
    }));

  const live = rows.filter((r) => r.disposition.kind === 'live').map((r) => r.name);
  const sockets = rows.filter((r) => r.disposition.kind === 'socket').map((r) => r.name);

  return {
    recipes: registry.slice().sort() as RecipeName[],
    rows,
    live,
    sockets,
    brokenPromises,
  };
}

export function liveRecipeKeys(inventory = buildRecipeMatrixInventory()): readonly string[] {
  return inventory.live.slice();
}

export function socketRecipeKeys(inventory = buildRecipeMatrixInventory()): readonly string[] {
  return inventory.sockets.slice();
}

export function countByKind(inventory = buildRecipeMatrixInventory()): { live: number; socket: number } {
  return { live: inventory.live.length, socket: inventory.sockets.length };
}
