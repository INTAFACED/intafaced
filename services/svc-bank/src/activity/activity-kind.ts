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
 * ORDER HOLD vs RELEASE. Classified only from the ledger's own `module/reason`
 * (`trade / order.hold`, `order.hold.amend`, `order.hold.released`), never from
 * amounts or timing. Spot orders and Convert (#4678) post the same recipes.
 * A fill spends from the hold account, not `available`, so fill legs stay `trade`.
 * Added after the first six-kind release: a client that does not know these two
 * kinds must treat an unknown kind as `other`.
 *
 * DEPOSIT vs WELCOME FUNDS. A real deposit and a local-test grant both post
 * `ledger / deposit.credited`; only the post's rail tells them apart. The ledger
 * page returns that rail (allow-listed: crypto-native, card-sandbox,
 * bank-crypto-ledger, local-test, else null). `local-test` is `welcome_funds`;
 * an unknown rail, or a ledger that does not send one yet, stays `deposit`.
 *
 * EARN, STAKING, REWARD. Added after the order kinds (PF-activity-01), from the reasons the book already
 * posts: `bank.earn.*` is earn, `token.stake`/`token.unstake` is staking, `token.yield.distributed`, card
 * cashback and any `reward*` or `token.yield*` reason is reward. Dividends and corporate actions have no ledger
 * reason on this platform and are not invented. A client that does not know these kinds treats them as `other`.
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
  'order_hold',
  'order_release',
  'earn',
  'staking',
  'reward',
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
  // A customer maker's sale to the token buyback (recipes/buyback.ts `buybackTakerFill`).
  'trade/trade.fill.buyback': 'trade',
  'trade/futures.margin.lock': 'trade',
  'trade/futures.margin.add': 'trade',
  'trade/futures.margin.release': 'trade',
  'trade/futures.loss.realized': 'trade',
  'trade/futures.profit.realized': 'trade',
  'trade/futures.funding.paid': 'trade',
  // Order reservations are value set aside, not a settled movement (recipes/index.ts:292-347, order-hold-amend.ts:45).
  // The customer's own hold, its top-up and its release are named; spot orders and Convert post the same recipes.
  'trade/order.hold': 'order_hold',
  'trade/order.hold.amend': 'order_hold',
  'trade/order.hold.released': 'order_release',
  // House market-maker holds sit on the house's account, never a customer's; they stay unnamed.
  'trade/order.hold.mm': 'other',
  'trade/order.hold.mm.released': 'other',
  // The token buyback's own hold sits on a house account too (recipes/buyback.ts).
  'trade/order.hold.buyback': 'other',
  'trade/order.hold.buyback.released': 'other',
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

  // Earn, staking and rewards have a kind of their own (the vocabulary analytics/spend.ts `categorise` uses).
  // Loans and the token house postings have none in this contract (recipes/loans.ts, index.ts:897-957).
  'bank/bank.earn.deposited': 'earn',
  'bank/bank.earn.withdrawn': 'earn',
  'bank/bank.earn.interest': 'earn',
  // The pool reserve is the house's account, never a customer's; it stays unnamed.
  'bank/bank.earn.pool.funded': 'other',
  'bank/loan.collateral.locked': 'other',
  'bank/loan.collateral.released': 'other',
  'bank/loan.drawn': 'other',
  'bank/loan.repaid': 'other',
  'bank/loan.liquidated': 'other',
  'bank/loan.bad_debt.covered': 'other',
  'bank/loan.reserve.funded': 'other',
  'token/token.stake': 'staking',
  'token/token.unstake': 'staking',
  'token/token.emission': 'other',
  'token/token.burn': 'other',
  'token/token.fee.swept': 'other',
  'token/token.yield.distributed': 'reward',
  'token/bank.card.cashback': 'reward',
};

/**
 * `reason` alone, for postings whose module is the CALLER's (`feeCharge` takes
 * any module, recipes/index.ts:990/1014). Checked after the exact table.
 */
export const KIND_BY_REASON: Readonly<Record<string, Row>> = {
  'fee.charged': 'fee',
};

/**
 * `reason` prefixes, checked last: a reward the book posts under a reason this table has not met yet
 * (`reward.*`, `token.yield*`) is still a reward, exactly as `categorise` files it.
 */
export const KIND_BY_REASON_PREFIX: ReadonlyArray<readonly [string, Row]> = [
  ['reward', 'reward'],
  ['token.yield', 'reward'],
];

/** Rails whose credit is a local-test "welcome funds" grant. The ledger page reports the rail (allow-listed, else null). */
export const WELCOME_FUNDS_RAILS: ReadonlySet<string> = new Set<string>(['local-test']);

export interface ClassifyInput {
  readonly module: string;
  readonly reason: string;
  readonly direction: EntryDirection;
  /** The rail a deposit arrived on, when the ledger page says (null or absent = unknown). */
  readonly rail?: string | null;
}

/** The direction the person sees, from the ledger's `debit increases` convention. */
export function directionOf(direction: EntryDirection): 'in' | 'out' {
  return direction === 'debit' ? 'in' : 'out';
}

export function classify(input: ClassifyInput): ActivityKind {
  const row =
    KIND_BY_MODULE_REASON[`${input.module}/${input.reason}`] ??
    KIND_BY_REASON[input.reason] ??
    KIND_BY_REASON_PREFIX.find(([prefix]) => input.reason.startsWith(prefix))?.[1] ??
    'other';
  if (row === 'transfer') return input.direction === 'debit' ? 'transfer_in' : 'transfer_out';
  if (row === 'deposit' && input.rail != null && WELCOME_FUNDS_RAILS.has(input.rail)) return 'welcome_funds';
  return row;
}

/** The words a screen shows for each kind. */
export const ACTIVITY_KIND_LABELS: Readonly<Record<ActivityKind, string>> = {
  deposit: 'Deposit',
  welcome_funds: 'Welcome test funds',
  transfer_in: 'Transfer received',
  transfer_out: 'Transfer sent',
  trade: 'Trade',
  fee: 'Fee',
  payment: 'Payment',
  withdrawal: 'Withdrawal',
  space_move: 'Moved between Spaces',
  order_hold: 'Set aside for an order',
  order_release: 'Returned from an order',
  earn: 'Earn',
  staking: 'Staking',
  reward: 'Reward',
  other: 'Other',
};
