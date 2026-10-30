import type { RecipeName } from './index.js';

/**
 * D26-P0-09 — Fee + revenue recipe map (DIRECTION §8 item 6).
 *
 * Closed matrix: every fee / revenue path is either a **named recipe already
 * exported from this package**, or a **§13 socket / DIRECTION residual**.
 * Agents must not invent ledger recipes — this inventory only records what
 * tip already has. Adding a path that needs a new recipe is an owner event,
 * not a silent PR.
 *
 * `RECIPES_TOUCHING_HOUSE_FEES` is the machine half: every recipe whose source
 * posts to `houseFees(...)` must appear on at least one matrix row. The test
 * re-derives that set from recipe sources so a new fee-touching recipe that
 * skips the matrix fails CI.
 */

export type FeeRevenueRecipeClosure = {
  kind: 'recipe';
  recipe: RecipeName;
  /** `houseFees(<module>, …)` slug when the path collects or draws a fee pot. */
  feeModule?: string;
  note: string;
};

export type FeeRevenueSocketClosure = {
  kind: 'socket';
  /**
   * Tracker id (`socket.*` / product row) or a DIRECTION residual pointer
   * (`DIRECTION§8.…`). Sockets must exist in `tooling/tracker/features.mjs`
   * when they use the `socket.` / product-id form.
   */
  socket: string;
  note: string;
};

export type FeeRevenueClosure = FeeRevenueRecipeClosure | FeeRevenueSocketClosure;

/**
 * Product fee / revenue paths → named recipe or §13.
 * Keys are stable path ids (not recipe names) so one recipe can close several
 * surfaces (e.g. `feeCharge` for agents metering and bank/card charges).
 */
export const FEE_REVENUE_PATHS = {
  'trade.spot.fill_fee': {
    kind: 'recipe',
    recipe: 'tradeFill',
    feeModule: 'trade',
    note: 'Maker/taker bps on fill → houseFees(trade).',
  },
  'trade.spot.fill_fee_correction': {
    kind: 'recipe',
    recipe: 'tradeFillFeeCorrection',
    feeModule: 'trade',
    note: 'Excess posted fill fee returns from houseFees(trade) under a new key. The original trade.fill stays.',
  },
  'trade.spot.fill_maker_rebate': {
    kind: 'recipe',
    recipe: 'tradeFillMakerRebate',
    feeModule: 'trade',
    note: 'A maker rebate leaves houseFees(trade) in the asset the maker paid, below the same fill taker fee. The trade.fill stays.',
  },
  'trade.spot.mm_maker_fill_fee': {
    kind: 'recipe',
    recipe: 'marketMakerMakerFill',
    feeModule: 'trade',
    note: 'MM maker fill fees → houseFees(trade).',
  },
  'trade.spot.buyback_maker_fee': {
    kind: 'recipe',
    recipe: 'buybackTakerFill',
    feeModule: 'trade',
    note: 'The customer maker fee on a token buyback IOC fill, in quote → houseFees(trade). The house buys as taker and pays no taker fee to itself.',
  },
  'trade.futures.fill_fee': {
    kind: 'recipe',
    recipe: 'futuresOrderMarginApply',
    feeModule: 'trade',
    note: 'An opening or growing futures fill pays its maker or taker fee from the order hold → houseFees(trade), in the fill posting.',
  },
  'trade.futures.close_fee': {
    kind: 'recipe',
    recipe: 'futuresMarginRelease',
    feeModule: 'trade',
    note: 'A reducing futures fill pays its fee from the position pot → houseFees(trade), in the release posting.',
  },
  'trade.futures.realize_loss_sink': {
    kind: 'recipe',
    recipe: 'futuresRealizeLoss',
    note: 'Realized loss debits house futures-loss. It does not touch houseFees(trade).',
  },
  'trade.futures.realize_profit': {
    kind: 'recipe',
    recipe: 'futuresRealizeProfit',
    note: 'Pays user from house futures-loss, the clearing pot losers pay into. It does not touch houseFees(trade).',
  },
  'trade.futures.insurance_topup': {
    kind: 'recipe',
    recipe: 'futuresInsuranceTopup',
    feeModule: 'trade',
    note: 'Draws houseFees(trade) → insuranceFund.',
  },
  'trade.futures.profit_source_capitalisation': {
    kind: 'socket',
    socket: 'DIRECTION§8.6',
    note: 'TRADE_FUTURES_PROFIT_SOURCE — which account funds profit and how it is capitalised. Recipe exists; source is unset until owner names it.',
  },
  'trade.copy.fee_share_sweep': {
    kind: 'recipe',
    recipe: 'sweepFeesToRewards',
    feeModule: 'trade',
    note: 'Copy fee-share mechanism drains houseFees → rewardsEngine; rates refuse until §8.10.',
  },
  'trade.copy.fee_share_pay': {
    kind: 'recipe',
    recipe: 'rewardPay',
    note: 'Leader payout from rewardsEngine after sweep (not a second fee invent).',
  },
  'trade.copy.fee_share_rates': {
    kind: 'socket',
    socket: 'DIRECTION§8.10',
    note: 'leader_share_bps and copy fee-share rates — refuse-closed until published.',
  },
  'p2p.escrow_release_fee': {
    kind: 'recipe',
    recipe: 'escrowRelease',
    feeModule: 'p2p',
    note: 'Optional feeBps on release → houseFees(p2p).',
  },
  'p2p.convert_spread': {
    kind: 'socket',
    socket: 'DIRECTION§8.6',
    note: 'Convert house spread is an RFQ cushion, not a fee recipe; any house take rides tradeFill.',
  },
  'pay.merchant_settlement_fee': {
    kind: 'recipe',
    recipe: 'merchantSettlement',
    feeModule: 'pay',
    note: 'Merchant settlement fee → houseFees(pay).',
  },
  'pay.withdraw_network_fee': {
    kind: 'recipe',
    recipe: 'withdrawSettle',
    feeModule: 'pay',
    note: 'The quoted network fee of a crypto withdrawal, held with the amount and drawn from that hold on settle → houseFees(pay). No fee omits the leg; a reverse returns it with the amount.',
  },
  'pay.conversion_fee_spread': {
    kind: 'recipe',
    recipe: 'fxConversion',
    feeModule: 'pay',
    note: 'Sandbox USD→USDT conversion: locked fee and spread, in the to-asset, → houseFees(pay). Zero omits the leg.',
  },
  'pay.conversion_fee_spread_reverse': {
    kind: 'recipe',
    recipe: 'fxConversionReverse',
    feeModule: 'pay',
    note: 'Reverses a below-minimum conversion fill onto house inventory. Venue-boundary legs stay on the original booking.',
  },
  'pay.conversion_late_fill': {
    kind: 'recipe',
    recipe: 'fxConversionLateFill',
    feeModule: 'pay',
    note: 'Late-fill booking from merchant clearing: the original order fee and spread, in the to-asset, → houseFees(pay). Zero omits the leg. Inventory funding books the venue position to fx-inventory and posts no fee.',
  },
  'token.fee_charge': {
    kind: 'recipe',
    recipe: 'feeCharge',
    note: 'Generic module fee charge (trade/bank/agents/…) → houseFees(<module>).',
  },
  'token.fee_sweep': {
    kind: 'recipe',
    recipe: 'sweepFeesToRewards',
    note: 'House fee pot → rewardsEngine for real-yield trail.',
  },
  'token.reward_pay': {
    kind: 'recipe',
    recipe: 'rewardPay',
    note: 'RewardsEngine → user (yield / cashback / prizes).',
  },
  'token.yield_house_fee_aggregation': {
    kind: 'recipe',
    recipe: 'sweepFeesToRewards',
    note: 'Weekly yield job reads houseFees(module) via ledger.balance and sweeps through sweepFeesToRewards; never caller-typed sources[].amount. Unset/off is token.yield_job_unset.',
  },
  'bank.loan_interest': {
    kind: 'recipe',
    recipe: 'loanRepay',
    feeModule: 'bank',
    note: 'Loan interest → houseFees(bank).',
  },
  'bank.loan_liquidation_interest_penalty': {
    kind: 'recipe',
    recipe: 'loanLiquidate',
    feeModule: 'bank',
    note: 'Interest + penalty legs → houseFees(bank); principal is not house revenue.',
  },
  'bank.loan_reserve_fund': {
    kind: 'recipe',
    recipe: 'loanReserveFund',
    feeModule: 'bank',
    note: 'Defaults from houseFees(bank) into loan reserve.',
  },
  'bank.earn_pool_fund': {
    kind: 'recipe',
    recipe: 'earnPoolFund',
    feeModule: 'bank',
    note: 'Defaults from houseFees(bank) into earn pool reserve (named yield source).',
  },
  'market.commerce_commission': {
    kind: 'recipe',
    recipe: 'marketPurchase',
    feeModule: 'market',
    note: 'Listing commission → houseFees(market); blank bps refused upstream.',
  },
  'market.commerce_commission_held': {
    kind: 'recipe',
    recipe: 'marketPurchaseRelease',
    feeModule: 'market',
    note: 'The same listing commission, taken when a held purchase is released after its refund window; blank bps refused upstream.',
  },
  'market.listing_fee': {
    kind: 'recipe',
    recipe: 'marketListingFee',
    feeModule: 'market',
    note: 'Vendor listing fee → houseFees(market); §13 unwired in svc-market until owner publishes amounts.',
  },
  'market.premium_placement': {
    kind: 'recipe',
    recipe: 'marketPremiumPlacement',
    feeModule: 'market',
    note: 'Vendor premium placement → houseFees(market); §13 unwired until a writer posts.',
  },
  'ops.affiliate_payout': {
    kind: 'recipe',
    recipe: 'sweepFeesToRewards',
    note: 'Affiliate payout engine sweeps named fee pools then rewardPay; does not invent a recipe.',
  },
  'ops.affiliate_rates': {
    kind: 'socket',
    socket: 'DIRECTION§8.10',
    note: 'Affiliate / IB fee-share rates — refuse-closed when unpublished (ops.affiliates).',
  },
  'dex.venue_fee_schedule': {
    kind: 'socket',
    socket: 'socket.dex-fee-source',
    note: 'Authoritative per-venue fee + settlement schedule — configured guesses until owner/chain seal.',
  },
  'launch.factory_fee': {
    kind: 'socket',
    socket: 'launch.token-factory',
    note: 'Factory is not payable; a launch fee would be a Fiat Plane recipe (§0.6) — not invented here.',
  },
} as const satisfies Record<string, FeeRevenueClosure>;

export type FeeRevenuePathId = keyof typeof FEE_REVENUE_PATHS;

/**
 * Every recipe whose implementation posts `houseFees(...)`.
 * Keep in lockstep with recipe sources — the inventory test re-derives this
 * from disk and fails on drift (no silent new fee recipe).
 */
export const RECIPES_TOUCHING_HOUSE_FEES = [
  'tradeFill',
  'tradeFillFeeCorrection',
  'tradeFillMakerRebate',
  'marketMakerMakerFill',
  'futuresInsuranceTopup',
  'futuresMarginRelease',
  'futuresOrderMarginApply',
  'escrowRelease',
  'merchantSettlement',
  'fxConversion',
  'fxConversionLateFill',
  'fxConversionReverse',
  'withdrawSettle',
  'feeCharge',
  'sweepFeesToRewards',
  'loanRepay',
  'loanLiquidate',
  'loanReserveFund',
  'earnPoolFund',
  'marketPurchase',
  'marketPurchaseRelease',
  'buybackTakerFill',
  'marketListingFee',
  'marketPremiumPlacement',
] as const satisfies readonly RecipeName[];
