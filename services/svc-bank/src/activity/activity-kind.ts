/**
 * ACTIVITY KIND — which ledger `module`/`reason` is which thing a person calls it.
 *
 * ONE FILE, ONE TABLE. `bank.activity.list` shows the ledger's own words as
 * typed rows ("Deposit", "Fee", "Trade"). The ledger's reasons are a permanent
 * record and must not change to suit a screen, so the screen's vocabulary lives
 * here and nowhere else. Every row has a test (`activity-kind.test.ts`).
 *
 * UNKNOWN IS `other`, NEVER DROPPED. A history that quietly left out a posting
 * it did not recognise would be a plausible list with money missing from it.
 *
 * DIRECTION. The book's convention is "debit increases the account, credit
 * decreases it" (analytics/ledger-history.ts). The feed reads the user's
 * `available` accounts, so a debit is money IN and a credit is money OUT.
 *
 * INVENTORY (grep of every ledger posting site on the tip this was written on):
 *   packages/ledger-client/src/recipes/index.ts   deposit 83-84, mm seed 119-120, withdraw 131-165,
 *     trade.fill 266-267, order.hold 292-347, mm fill 417-418, futures 451-620, p2p 648-715,
 *     pay 758-877, token 897-957, fee.charged 990/1014 (any module), token.fee.swept 1050-1051,
 *     rewardPay 1062-1063 (reason supplied by the caller)
 *   packages/ledger-client/src/recipes/bank.ts    transfer 95-96, earn 125-290, business 334-439
 *   packages/ledger-client/src/recipes/loans.ts   loan.* 125-485
 *   packages/ledger-client/src/recipes/chargeback.ts 200-353, market.ts 117-198,
 *     sub-accounts.ts 79-80, order-hold-amend.ts 45-46
 *   services/svc-bank/src/cards/card-service.ts:1095    rewardPay reason 'bank.card.cashback'
 *   services/svc-token/src/token-service.ts:1072        rewardPay reason 'token.yield.distributed'
 *
 * NOT DECIDABLE FROM module/reason: a real deposit and an operator-credited
 * "welcome funds" credit both post `ledger / deposit.credited`; only the post's
 * `meta.rail` tells them apart and the ledger page does not return `meta`
 * (services/svc-ledger/src/ledger/history.ts HistoryPageEntry). So today every
 * such credit is `deposit`. `welcome_funds` is produced only when a caller can
 * name the rail, via `WELCOME_FUNDS_RAILS` and `classify({ rail })`.
 */

export const ACTIVITY_KINDS = [
  'deposit',
  'welcome_funds',
  'transfer_in',
  'transfer_out',
  'trade',
  'fee',
  'payment',
  'withdrawal',
  'space_move',
  'other',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type EntryDirection = 'debit' | 'credit';

/** What a table row says. `transfer` is resolved to in/out by direction. */
type Row = ActivityKind | 'transfer';

/** `module/reason` -> kind. Exact match, checked first. */
export const KIND_BY_MODULE_REASON: Readonly<Record<string, Row>> = {
  // Money across the platform boundary (recipes/index.ts:83, 131, 146, 164)
  'ledger/deposit.credited': 'deposit',
  'ledger/withdraw.held': 'withdrawal',
  'ledger/withdraw.settled': 'withdrawal',
  'ledger/withdraw.reversed': 'withdrawal',

  // Moves between the user's own pots, or to another user (recipes/bank.ts:95-96, sub-accounts.ts:79-80)
  'bank/bank.transfer.manual': 'transfer',
  'bank/bank.transfer.scheduled': 'transfer',
  'identity/identity.sub_account.transfer': 'space_move',

  // Trading (recipes/index.ts:266, 417, 451-598)
  'trade/trade.fill': 'trade',
  'trade/trade.fill.mm_maker': 'trade',
  'trade/futures.margin.lock': 'trade',
  'trade/futures.margin.add': 'trade',
  'trade/futures.margin.release': 'trade',
  'trade/futures.loss.realized': 'trade',
  'trade/futures.profit.realized': 'trade',
  'trade/futures.funding.paid': 'trade',
  // Order reservations are value set aside, not a settled movement (recipes/index.ts:292-347, order-hold-amend.ts:45)
  'trade/order.hold': 'other',
  'trade/order.hold.released': 'other',
  'trade/order.hold.mm': 'other',
  'trade/order.hold.mm.released': 'other',
  'trade/order.hold.amend': 'other',
  // House-side postings: never on a user's account, listed so the inventory is closed (index.ts:119, 619)
  'trade/mm.seed.funded': 'other',
  'trade/futures.insurance.topup': 'other',

  // Peer-to-peer escrow (recipes/index.ts:648-715)
  'p2p/p2p.escrow.lock': 'trade',
  'p2p/p2p.escrow.release': 'trade',
  'p2p/p2p.escrow.refund': 'trade',

  // Payments (recipes/index.ts:758-877, chargeback.ts:200-353)
  'pay/payment.captured': 'payment',
  'pay/pay.settled': 'payment',
  'pay/payment.refunded': 'payment',
  'pay/payment.refund.reversed': 'payment',
  'pay/pay.chargeback.opened': 'payment',
  'pay/pay.chargeback.shortfall.covered': 'payment',
  'pay/pay.chargeback.won': 'payment',
  'pay/pay.chargeback.shortfall.recovered': 'payment',
  'market/market.purchase': 'payment',
  'market/market.listing_fee': 'fee',
  'market/market.premium_placement': 'fee',
  'bank/bank.business.approval.settled': 'payment',
  'bank/bank.business.payroll.settled': 'payment',
  'bank/bank.business.approval.held': 'other',
  'bank/bank.business.approval.released': 'other',

  // Earn, loans, tokens and rewards have no kind of their own in this contract (recipes/bank.ts, loans.ts, index.ts:897-957)
  'bank/bank.earn.deposited': 'other',
  'bank/bank.earn.withdrawn': 'other',
  'bank/bank.earn.interest': 'other',
  'bank/bank.earn.pool.funded': 'other',
  'bank/loan.collateral.locked': 'other',
  'bank/loan.collateral.released': 'other',
  'bank/loan.drawn': 'other',
  'bank/loan.repaid': 'other',
  'bank/loan.liquidated': 'other',
  'bank/loan.bad_debt.covered': 'other',
  'bank/loan.reserve.funded': 'other',
  'token/token.stake': 'other',
  'token/token.unstake': 'other',
  'token/token.emission': 'other',
  'token/token.burn': 'other',
  'token/token.fee.swept': 'other',
  'token/token.yield.distributed': 'other',
  'token/bank.card.cashback': 'other',
};

/**
 * `reason` alone, for postings whose module is the CALLER's (`feeCharge` takes
 * any module, recipes/index.ts:990/1014). Checked after the exact table.
 */
export const KIND_BY_REASON: Readonly<Record<string, Row>> = {
  'fee.charged': 'fee',
};

/** Rails whose credit is an operator/local-test "welcome funds" grant. Empty until a deployment names them. */
export const WELCOME_FUNDS_RAILS: ReadonlySet<string> = new Set<string>();

export interface ClassifyInput {
  readonly module: string;
  readonly reason: string;
  readonly direction: EntryDirection;
  /** Only when the ledger page can say which rail a deposit arrived on. */
  readonly rail?: string;
}

/** The direction the person sees, from the ledger's `debit increases` convention. */
export function directionOf(direction: EntryDirection): 'in' | 'out' {
  return direction === 'debit' ? 'in' : 'out';
}

export function classify(input: ClassifyInput): ActivityKind {
  const row = KIND_BY_MODULE_REASON[`${input.module}/${input.reason}`] ?? KIND_BY_REASON[input.reason] ?? 'other';
  if (row === 'transfer') return input.direction === 'debit' ? 'transfer_in' : 'transfer_out';
  if (row === 'deposit' && input.rail !== undefined && WELCOME_FUNDS_RAILS.has(input.rail)) return 'welcome_funds';
  return row;
}
