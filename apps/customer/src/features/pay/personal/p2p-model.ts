/**
 * Pure rules for the person-to-person rooms: order buckets, the escrow path of an order, time left, what a take would
 * cost before fees, offer filters, and offer-form checks. No React, no network. Money is exact decimals.
 */
import { dec, str, times } from '../../../data/decimal';
import type { Offer, Reputation, TakeQuote, Trade } from '../schemas';

// ── Orders ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type OrderBucket = 'active' | 'disputed' | 'completed' | 'cancelled';
export type OrderFilter = OrderBucket | 'all';

export function orderBucket(trade: Pick<Trade, 'status'>): OrderBucket {
  switch (trade.status) {
    case 'created':
    case 'escrowed':
    case 'fiat_sent':
      return 'active';
    case 'disputed':
      return 'disputed';
    case 'released':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
  }
}

export function filterOrders<T extends Pick<Trade, 'status'>>(trades: readonly T[], filter: OrderFilter): T[] {
  return filter === 'all' ? [...trades] : trades.filter((trade) => orderBucket(trade) === filter);
}

export function orderCounts(trades: readonly Pick<Trade, 'status'>[]): Record<OrderFilter, number> {
  const counts: Record<OrderFilter, number> = { all: trades.length, active: 0, disputed: 0, completed: 0, cancelled: 0 };
  for (const trade of trades) counts[orderBucket(trade)] += 1;
  return counts;
}

// ── The escrow path of one order ────────────────────────────────────────────────────────────────────────────────

export type StepId = 'created' | 'escrowed' | 'fiat_sent' | 'closed';
export type StepState = 'done' | 'current' | 'pending' | 'unknown' | 'stopped';
export type Role = 'buyer' | 'seller' | 'observer';
export type Outcome = 'open' | 'released' | 'returned' | 'voided' | 'disputed' | 'cancelled';
export type Waiting = 'you' | 'counterparty' | 'service' | 'moderator' | 'nobody';
export type OrderAction = 'markPaid' | 'release' | 'cancel' | 'dispute';

export interface EscrowView {
  role: Role;
  steps: { id: StepId; state: StepState }[];
  outcome: Outcome;
  waitingOn: Waiting;
  /** What this person can do now, by the same rules the order page offers. */
  actions: OrderAction[];
}

type TradeFacts = Pick<Trade, 'status' | 'resolution' | 'buyerId' | 'sellerId' | 'escrowedAt'>;

export function roleIn(trade: Pick<Trade, 'buyerId' | 'sellerId'>, userId: string | null): Role {
  if (!userId) return 'observer';
  if (trade.buyerId === userId) return 'buyer';
  return trade.sellerId === userId ? 'seller' : 'observer';
}

/**
 * Where the order is on the escrow path. Created, then the asset locked, then payment reported, then closed.
 * A cancelled or disputed order may have stopped before payment was reported; the service does not say, so that step
 * stays "unknown" instead of being guessed.
 */
export function escrowView(trade: TradeFacts, userId: string | null): EscrowView {
  const role = roleIn(trade, userId);
  const locked = trade.escrowedAt !== null;
  const steps = (states: Record<StepId, StepState>) =>
    (['created', 'escrowed', 'fiat_sent', 'closed'] as const).map((id) => ({ id, state: states[id] }));
  const actions: OrderAction[] = [];
  if (role === 'buyer' && trade.status === 'escrowed') actions.push('markPaid');
  if (role === 'seller' && trade.status === 'fiat_sent') actions.push('release');
  // No cancel once the buyer has marked paid: the way out for either side is release or a dispute.
  if (role !== 'observer' && (trade.status === 'created' || trade.status === 'escrowed')) actions.push('cancel');
  if (role !== 'observer' && (trade.status === 'escrowed' || trade.status === 'fiat_sent')) actions.push('dispute');
  switch (trade.status) {
    case 'created':
      return {
        role,
        outcome: 'open',
        waitingOn: 'service',
        actions,
        steps: steps({ created: 'current', escrowed: 'pending', fiat_sent: 'pending', closed: 'pending' }),
      };
    case 'escrowed':
      return {
        role,
        outcome: 'open',
        waitingOn: role === 'buyer' ? 'you' : 'counterparty',
        actions,
        steps: steps({ created: 'done', escrowed: 'done', fiat_sent: 'current', closed: 'pending' }),
      };
    case 'fiat_sent':
      return {
        role,
        outcome: 'open',
        waitingOn: role === 'seller' ? 'you' : 'counterparty',
        actions,
        steps: steps({ created: 'done', escrowed: 'done', fiat_sent: 'done', closed: 'current' }),
      };
    case 'disputed':
      return {
        role,
        outcome: 'disputed',
        waitingOn: 'moderator',
        actions,
        steps: steps({ created: 'done', escrowed: 'done', fiat_sent: 'unknown', closed: 'stopped' }),
      };
    case 'released':
      return {
        role,
        outcome: 'released',
        waitingOn: 'nobody',
        actions,
        steps: steps({ created: 'done', escrowed: 'done', fiat_sent: 'done', closed: 'done' }),
      };
    case 'cancelled':
      return {
        role,
        outcome: trade.resolution === 'voided' ? 'voided' : trade.resolution === 'refunded' ? 'returned' : 'cancelled',
        waitingOn: 'nobody',
        actions,
        steps: steps({ created: 'done', escrowed: locked ? 'done' : 'unknown', fiat_sent: 'unknown', closed: 'stopped' }),
      };
  }
}

/** Time to a deadline. The service owns the deadline; this only does the subtraction. */
export function timeLeft(
  deadlineAt: string | null,
  nowMs: number,
): { kind: 'none' } | { kind: 'left' | 'past'; hours: number; minutes: number } {
  if (!deadlineAt) return { kind: 'none' };
  const at = Date.parse(deadlineAt);
  if (!Number.isFinite(at)) return { kind: 'none' };
  const diff = at - nowMs;
  const abs = Math.abs(diff);
  return { kind: diff >= 0 ? 'left' : 'past', hours: Math.floor(abs / 3_600_000), minutes: Math.floor((abs % 3_600_000) / 60_000) };
}

/** The four stages of a dispute, from what the service reports. */
export type DisputeStage = 'opened' | 'evidence' | 'review' | 'ruled';
export function disputeStages(dispute: {
  status: 'open' | 'resolved';
  evidence: readonly unknown[];
  moderatorId: string | null;
  lastSeenByModeratorAt: string | null;
}): { id: DisputeStage; state: 'done' | 'current' | 'pending' }[] {
  const resolved = dispute.status === 'resolved';
  const reviewing = resolved || dispute.moderatorId !== null || dispute.lastSeenByModeratorAt !== null;
  const stages: { id: DisputeStage; done: boolean }[] = [
    { id: 'opened', done: true },
    { id: 'evidence', done: dispute.evidence.length > 0 || reviewing },
    { id: 'review', done: resolved },
    { id: 'ruled', done: resolved },
  ];
  let current = false;
  return stages.map(({ id, done }) => {
    if (done) return { id, state: 'done' as const };
    if (!current) {
      current = true;
      return { id, state: 'current' as const };
    }
    return { id, state: 'pending' as const };
  });
}

// ── Offers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const offerMethodIds = (offer: Pick<Offer, 'methods'>): string[] =>
  offer.methods.flatMap((method) =>
    typeof method === 'string'
      ? [method]
      : method && typeof method === 'object' && 'id' in method && typeof (method as { id: unknown }).id === 'string'
        ? [(method as { id: string }).id]
        : [],
  );

export type TakeCheck =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'belowMin' }
  | { kind: 'aboveMax' }
  | { kind: 'aboveRemaining' }
  | { kind: 'ok'; amount: string; fiatTotal: string | null };

/**
 * What an order of this size would be against an offer, before fees. For a fixed price the external payment is price
 * times quantity, shown exact. A floating price follows a reference this screen does not have, so no total is invented.
 */
export function checkTake(
  offer: Pick<Offer, 'priceType' | 'price' | 'minAmount' | 'maxAmount' | 'remainingAmount'>,
  amount: string,
): TakeCheck {
  const text = amount.trim();
  if (text === '' || text === '.') return { kind: 'empty' };
  const typed = /^\d+(\.\d{1,18})?$/.test(text) ? dec(text) : null;
  if (typed === null || typed <= 0n) return { kind: 'invalid' };
  const min = dec(offer.minAmount);
  const max = dec(offer.maxAmount);
  const remaining = dec(offer.remainingAmount);
  const price = dec(offer.price);
  if (min === null || max === null || remaining === null || price === null) return { kind: 'invalid' };
  if (typed < min) return { kind: 'belowMin' };
  if (typed > max) return { kind: 'aboveMax' };
  if (typed > remaining) return { kind: 'aboveRemaining' };
  return { kind: 'ok', amount: str(typed), fiatTotal: offer.priceType === 'fixed' ? str(times(typed, price)) : null };
}

// ── Taking an offer ─────────────────────────────────────────────────────────────────────────────────────────────

/** True when the signed-in person made this offer. A maker never gets a take form on their own offer. */
export const isOwnOffer = (offer: Pick<Offer, 'makerId'>, userId: string | null | undefined): boolean =>
  Boolean(userId) && offer.makerId.toLowerCase() === userId!.toLowerCase();

/** The offer's side is the maker's. The person taking it is on the other side: a maker who sells means the taker buys. */
export const takerRole = (offer: Pick<Offer, 'side'>): 'buyer' | 'seller' => (offer.side === 'sell' ? 'buyer' : 'seller');

/** One whole-percent string from basis points, exact: 30 -> "0.3", 125 -> "1.25", 0 -> "0". */
export function feePercent(feeBps: number): string {
  const whole = Math.floor(feeBps / 100);
  const fraction = String(feeBps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * True when a typed quantity is more than the seller has available. Only a complete, valid number is judged; anything
 * else is left to the quantity checks. Exact decimals, no rounding.
 */
export function exceedsAvailable(amountText: string, available: string): boolean {
  const text = amountText.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(text)) return false;
  const typed = dec(text);
  const have = dec(available);
  return typed !== null && have !== null && typed > 0n && typed > have;
}

export type TakeRequest = { offerId: string; amount: string; method: string };
export type TakeRequestCheck =
  { ok: true; request: TakeRequest } | { ok: false; kind: Exclude<TakeCheck['kind'], 'ok'> | 'noMethod' | 'inactive' };

/**
 * The one request a quote and a take are built from. Same amount text, same method, same offer: the reviewed figures
 * can only ever describe the order that is then placed.
 */
export function takeRequest(
  offer: Pick<Offer, 'id' | 'status' | 'priceType' | 'price' | 'minAmount' | 'maxAmount' | 'remainingAmount' | 'methods'>,
  amountText: string,
  method: string,
): TakeRequestCheck {
  if (offer.status !== 'active') return { ok: false, kind: 'inactive' };
  const check = checkTake(offer, amountText);
  if (check.kind !== 'ok') return { ok: false, kind: check.kind };
  if (!method || !offerMethodIds(offer).includes(method)) return { ok: false, kind: 'noMethod' };
  return { ok: true, request: { offerId: offer.id.toLowerCase(), amount: check.amount, method } };
}

const same = (a: string, b: string) => {
  const x = dec(a);
  const y = dec(b);
  return x !== null && y !== null && x === y;
};

/**
 * A quote is only shown when it describes the request that was sent and adds up: the quantity is the one asked for,
 * the fee is within it and the net is exactly quantity minus fee, and a fixed offer is priced at the offer's price.
 * A reply that fails any of these is treated as no quote rather than shown.
 */
export function quoteIsConsistent(offer: Pick<Offer, 'priceType' | 'price'>, request: TakeRequest, quote: TakeQuote): boolean {
  const amount = dec(quote.amount);
  const fee = dec(quote.fee);
  const net = dec(quote.netAmount);
  if (amount === null || fee === null || net === null) return false;
  if (!same(quote.amount, request.amount)) return false;
  if (fee > amount || net !== amount - fee) return false;
  if (offer.priceType === 'fixed' && !same(quote.price, offer.price)) return false;
  return true;
}

/** Same figures, ignoring when the reservation would end (that moves with every quote). */
export const sameQuoteFigures = (a: TakeQuote, b: TakeQuote): boolean =>
  same(a.amount, b.amount) &&
  same(a.price, b.price) &&
  same(a.fiatAmount, b.fiatAmount) &&
  a.feeBps === b.feeBps &&
  same(a.fee, b.fee) &&
  same(a.netAmount, b.netAmount);

/** Terms that must not move between review and confirm. The remaining quantity is left out: other people may take some. */
export const sameTakeTerms = (a: Offer, b: Offer): boolean =>
  a.id.toLowerCase() === b.id.toLowerCase() &&
  a.makerId === b.makerId &&
  a.side === b.side &&
  a.asset === b.asset &&
  a.fiatCurrency === b.fiatCurrency &&
  a.priceType === b.priceType &&
  same(a.price, b.price) &&
  same(a.minAmount, b.minAmount) &&
  same(a.maxAmount, b.maxAmount) &&
  a.status === b.status &&
  a.terms === b.terms &&
  JSON.stringify(a.methods) === JSON.stringify(b.methods);

/** Does a returned order describe exactly the take that was asked for, for this person on the right side? */
export function tradeMatchesTake(
  trade: Trade,
  offer: Pick<Offer, 'id' | 'makerId' | 'side' | 'asset' | 'fiatCurrency'>,
  userId: string,
  request: Pick<TakeRequest, 'amount' | 'method'> | null,
  tradeId: string,
): boolean {
  const taker = offer.side === 'sell' ? trade.buyerId : trade.sellerId;
  const maker = offer.side === 'sell' ? trade.sellerId : trade.buyerId;
  return (
    trade.id.toLowerCase() === tradeId.toLowerCase() &&
    trade.offerId.toLowerCase() === offer.id.toLowerCase() &&
    taker.toLowerCase() === userId.toLowerCase() &&
    maker.toLowerCase() === offer.makerId.toLowerCase() &&
    trade.asset === offer.asset &&
    trade.fiatCurrency === offer.fiatCurrency &&
    (request === null || (trade.method === request.method && same(trade.amount, request.amount)))
  );
}

export type TakeFailure =
  | 'unconfirmed'
  | 'notFound'
  | 'termsChanged'
  | 'quoteChanged'
  | 'quoteExpired'
  | 'orderCap'
  | 'pairLimit'
  | 'verificationLimit'
  | 'limitsUnset'
  | 'methodRetired'
  | 'nonInstantRefused'
  | 'floatingCashRefused'
  | 'buyingPaused'
  | 'shortBalance'
  | 'ownOffer'
  | 'unavailable'
  | 'blocked'
  | 'methodRefused'
  | 'tooSmall'
  | 'outOfBounds'
  | 'signIn'
  | 'noRecord'
  | 'verify'
  | 'region'
  | 'contact'
  | 'stepUp'
  | 'stepUpExpired'
  | 'stepUpFailed'
  | 'stepUpUnchecked'
  | 'unchecked'
  | 'viewChanged'
  | 'noService'
  | 'generic';

/** Service refusals that are proof nothing was reserved or locked: they are raised before any inventory moves. */
export const DEFINITE_TAKE_CODES: ReadonlySet<string> = new Set([
  // A locked quote is checked before anything is reserved, and a take that already placed skips the check.
  'p2p.quote_expired',
  'p2p.quote_changed',
  'p2p.quote_not_found',
  'p2p.quote_mismatch',
  // The owner's take limits are checked before anything is reserved (svc-p2p take-limits.ts, verification-limits.ts).
  'p2p.active_order_cap',
  'p2p.pair_limit_exceeded',
  'p2p.config_unset',
  'p2p.verification_order_min',
  'p2p.verification_order_max',
  'p2p.verification_daily_limit',
  'p2p.verification_lifetime_limit',
  'p2p.verification_limit_currency',
  'p2p.verification_limits_invalid',
  'p2p.verification_level_unwired',
  // A retired payment method is refused before the take reserves anything.
  'p2p.method_delisted',
  // A non-instant method without the ad's consent rolls the take back: nothing stays reserved.
  'p2p.non_instant_not_accepted',
  // A floating ad on a method made cash in person rolls the take back: nothing stays reserved.
  'p2p.floating_not_allowed_for_method',
  // Buying paused after cancelled orders: checked before anything is reserved.
  'p2p.buying_restricted',
  // Selling into a buy ad from a short balance: the lock's only attempt was refused and the order voided, nothing held.
  'p2p.insufficient_balance',
  'p2p.offer_unfunded',
  'p2p.invalid_amount',
  'p2p.amount_below_min',
  'p2p.amount_above_max',
  'p2p.insufficient_offer_liquidity',
  'p2p.offer_not_active',
  'p2p.offer_not_found',
  'p2p.self_trade',
  'p2p.blocked',
  'p2p.take_refused',
  'p2p.release_unpostable',
  'p2p.trading_disabled',
  'p2p.fee_bps_unset',
  'p2p.invalid_fee_bps',
  'denied.kyc_required',
  'denied.region_blocked',
  'denied.region_unknown',
  // The eligibility gate (svc-p2p take-eligibility.ts) runs before the take reserves or locks anything.
  'p2p.contact_required',
  'p2p.contact_unverifiable',
  'p2p.take_gate_unwired',
  // The take's fresh confirmation (svc-p2p take-step-up.ts) is checked after the eligibility gate, before anything moves.
  'auth.step_up_required',
  'auth.step_up_expired',
  'auth.step_up_failed',
  'p2p.step_up_unverifiable',
]);
/** Replies that can follow a reservation or a lock: the order may exist, so these are never "nothing happened". */
export const OPEN_TAKE_CODES: ReadonlySet<string> = new Set([
  'p2p.trade_exists',
  'p2p.escrow_lock_uncertain',
  'p2p.escrow_terms_unproven',
  'p2p.escrow_missing',
  'p2p.trade_moved',
]);

/**
 * Whether a refused take is proof it did not happen. Only a named pre-lock refusal, or a plain request rejection
 * (bad request, not signed in, not allowed, not found), counts. A conflict, a precondition failure, a server error
 * or anything unrecognised may follow a reservation, so it is reported as unconfirmed and never retried blind.
 */
export function takeRefusalIsDefinite(failure: { reason: string; code?: string; status?: number }): boolean {
  if (failure.reason === 'uncertain' || failure.reason === 'aborted') return false;
  if (failure.code && DEFINITE_TAKE_CODES.has(failure.code)) return true;
  if (failure.code && OPEN_TAKE_CODES.has(failure.code)) return false;
  return failure.status !== undefined && [400, 401, 403, 404, 422].includes(failure.status);
}

/** A refusal as one plain kind. The screen turns the kind into words; no service text or code reaches the customer. */
export function takeFailureKind(failure: { reason: string; code?: string; status?: number }): TakeFailure {
  switch (failure.code) {
    case 'pay.take_unconfirmed':
    case 'pay.operation_unresolved':
    case 'pay.reconciliation_in_progress':
      return 'unconfirmed';
    case 'pay.take_not_found':
      return 'notFound';
    case 'pay.take_terms_changed':
      return 'termsChanged';
    case 'pay.take_quote_changed':
    case 'p2p.quote_changed':
    case 'p2p.quote_mismatch':
      return 'quoteChanged';
    case 'p2p.quote_expired':
    case 'p2p.quote_not_found':
      return 'quoteExpired';
    case 'p2p.active_order_cap':
      return 'orderCap';
    case 'p2p.pair_limit_exceeded':
      return 'pairLimit';
    case 'p2p.verification_order_min':
    case 'p2p.verification_order_max':
    case 'p2p.verification_daily_limit':
    case 'p2p.verification_lifetime_limit':
    case 'p2p.verification_limit_currency':
      return 'verificationLimit';
    case 'p2p.config_unset':
    case 'p2p.verification_limits_invalid':
    case 'p2p.verification_level_unwired':
      return 'limitsUnset';
    case 'p2p.method_delisted':
      return 'methodRetired';
    case 'p2p.non_instant_not_accepted':
      return 'nonInstantRefused';
    case 'p2p.floating_not_allowed_for_method':
      return 'floatingCashRefused';
    case 'p2p.buying_restricted':
      return 'buyingPaused';
    case 'p2p.insufficient_balance':
      return 'shortBalance';
    case 'pay.take_own_offer':
    case 'p2p.self_trade':
      return 'ownOffer';
    case 'pay.take_offer_unavailable':
    case 'p2p.offer_not_active':
    case 'p2p.offer_not_found':
    case 'p2p.offer_unfunded':
    case 'p2p.trading_disabled':
      return 'unavailable';
    case 'p2p.blocked':
      return 'blocked';
    case 'denied.kyc_required':
      return 'verify';
    case 'denied.region_blocked':
    case 'denied.region_unknown':
      return 'region';
    case 'p2p.take_refused':
      return 'methodRefused';
    case 'p2p.contact_required':
      return 'contact';
    case 'auth.step_up_required':
      return 'stepUp';
    case 'auth.step_up_expired':
      return 'stepUpExpired';
    case 'auth.step_up_failed':
      return 'stepUpFailed';
    case 'p2p.step_up_unverifiable':
      return 'stepUpUnchecked';
    case 'p2p.contact_unverifiable':
    case 'p2p.take_gate_unwired':
      return 'unchecked';
    case 'p2p.release_unpostable':
      return 'tooSmall';
    case 'p2p.invalid_amount':
    case 'p2p.amount_below_min':
    case 'p2p.amount_above_max':
    case 'p2p.insufficient_offer_liquidity':
      return 'outOfBounds';
    case 'pay.recovery_journal_unavailable':
      return 'noRecord';
    case 'pay.p2p_view_changed':
    case 'pay.reconciliation_context_changed':
      return 'viewChanged';
  }
  if (failure.reason === 'unauthorized' || failure.code === 'pay.session_required') return 'signIn';
  if (failure.reason === 'uncertain') return 'unconfirmed';
  if (failure.reason === 'unreachable' || failure.reason === 'not_supported') return 'noService';
  return 'generic';
}

/** Did the order come back priced differently from the quote the customer reviewed? */
export const tradeMovedFromQuote = (trade: Pick<Trade, 'price' | 'fiatAmount'>, quote: Pick<TakeQuote, 'price' | 'fiatAmount'>): boolean =>
  !same(trade.price, quote.price) || !same(trade.fiatAmount, quote.fiatAmount);

/**
 * Why a placed order is shown with a notice before it opens, or null when it opens straight away.
 *  - `earlier`: the service already had it from an earlier attempt, so its figures may differ from the review;
 *  - `moved`: it is priced differently from the quote just reviewed;
 *  - `resent`: this attempt placed it for the first time, under the reference held from the earlier attempt.
 */
export function placedNotice(input: {
  heldReference: string | null;
  trade: Pick<Trade, 'id' | 'price' | 'fiatAmount'>;
  quote: Pick<TakeQuote, 'price' | 'fiatAmount'>;
  placedNow: boolean;
}): 'earlier' | 'moved' | 'resent' | null {
  const held = input.heldReference !== null && input.trade.id.toLowerCase() === input.heldReference.toLowerCase();
  if (held && !input.placedNow) return 'earlier';
  if (tradeMovedFromQuote(input.trade, input.quote)) return 'moved';
  return held ? 'resent' : null;
}

// ── Who is on the other side ────────────────────────────────────────────────────────────────────────────────────

export type MakerSummary =
  | { kind: 'new' }
  | { kind: 'unfinished'; orders: number }
  | { kind: 'record'; orders: number; completionRate: number; releaseSecs: number | null };

/** What to say about a maker from the reputation the service returned. Only returned fields; nothing is derived or filled in. */
export function makerSummary(
  reputation: Pick<Reputation, 'tradesTotal' | 'completed' | 'cancelled' | 'completionRate' | 'avgReleaseSecs'>,
): MakerSummary {
  if (reputation.tradesTotal === 0) return { kind: 'new' };
  // Trades are counted when they are escrowed, but completed and cancelled only when they finish, so a trader whose
  // trades are all still open has a rate of 0% that says nothing about how they trade.
  if (reputation.completed + reputation.cancelled === 0) return { kind: 'unfinished', orders: reputation.tradesTotal };
  return {
    kind: 'record',
    orders: reputation.tradesTotal,
    completionRate: reputation.completionRate,
    // Release time is an average over completed orders; with none completed there is nothing to average.
    releaseSecs: reputation.completed > 0 ? reputation.avgReleaseSecs : null,
  };
}

/** Seconds as the two largest units: 45 -> {s:45}, 190 -> {m:3,s:10}, 7500 -> {h:2,m:5}. */
export function splitDuration(seconds: number): { unit: 'seconds' | 'minutes' | 'hours'; major: number; minor: number | null } {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return { unit: 'seconds', major: total, minor: null };
  if (total < 3600) return { unit: 'minutes', major: Math.floor(total / 60), minor: total % 60 };
  return { unit: 'hours', major: Math.floor(total / 3600), minor: Math.floor((total % 3600) / 60) };
}

// ── Offer form ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface OfferFormValues {
  side: 'buy' | 'sell';
  asset: string;
  fiatCurrency: string;
  priceType: 'fixed' | 'float';
  price: string;
  minAmount: string;
  maxAmount: string;
  totalAmount: string;
  methods: string[];
  terms: string;
  /** P-disputes-security-09: the seller accepts methods that are not instant. Set at post; an edit keeps it. */
  acceptsNonInstant: boolean;
}

export type OfferFormField = 'asset' | 'fiatCurrency' | 'price' | 'minAmount' | 'maxAmount' | 'totalAmount' | 'methods' | 'terms';
export type OfferFormProblem = 'required' | 'invalid' | 'minTooHigh' | 'totalTooLow' | 'tooLong' | 'nonInstantConsent';

export const emptyOffer = (): OfferFormValues => ({
  side: 'sell',
  asset: '',
  fiatCurrency: '',
  priceType: 'fixed',
  price: '',
  minAmount: '',
  maxAmount: '',
  totalAmount: '',
  methods: [],
  terms: '',
  acceptsNonInstant: false,
});

/** An existing offer as form values. The service does not return the original total, so that field starts empty. */
export const offerToForm = (offer: Offer): OfferFormValues => ({
  side: offer.side,
  asset: offer.asset,
  fiatCurrency: offer.fiatCurrency,
  priceType: offer.priceType,
  price: offer.price,
  minAmount: offer.minAmount,
  maxAmount: offer.maxAmount,
  totalAmount: '',
  methods: offerMethodIds(offer),
  terms: offer.terms,
  acceptsNonInstant: offer.acceptsNonInstant ?? false,
});

const exact = (value: string): bigint | null => {
  const text = value.trim();
  return /^\d+(\.\d{1,18})?$/.test(text) ? dec(text) : null;
};

/** Every problem with the form, by field. An empty object means the form is complete. */
/**
 * `nonInstant`: the registry's method ids that are not instant in some market. A sell ad choosing one needs the seller's
 * consent, as svc-p2p refuses `p2p.non_instant_not_accepted` without it.
 */
export function checkOfferForm(
  values: OfferFormValues,
  nonInstant: ReadonlySet<string> = new Set(),
): Partial<Record<OfferFormField, OfferFormProblem>> {
  const problems: Partial<Record<OfferFormField, OfferFormProblem>> = {};
  if (values.asset.trim() === '') problems.asset = 'required';
  else if (!/^[A-Z0-9._-]{1,16}$/.test(values.asset.trim().toUpperCase())) problems.asset = 'invalid';
  if (values.fiatCurrency.trim() === '') problems.fiatCurrency = 'required';
  else if (!/^[A-Z]{3}$/.test(values.fiatCurrency.trim())) problems.fiatCurrency = 'invalid';
  const positive = (field: 'price' | 'minAmount' | 'maxAmount') => {
    if (values[field].trim() === '') problems[field] = 'required';
    else {
      const value = exact(values[field]);
      if (value === null || value <= 0n) problems[field] = 'invalid';
    }
  };
  positive('price');
  positive('minAmount');
  positive('maxAmount');
  const min = exact(values.minAmount);
  const max = exact(values.maxAmount);
  if (!problems.minAmount && !problems.maxAmount && min !== null && max !== null && min > max) problems.minAmount = 'minTooHigh';
  if (values.totalAmount.trim() !== '') {
    const total = exact(values.totalAmount);
    if (total === null || total <= 0n) problems.totalAmount = 'invalid';
    else if (max !== null && total < max) problems.totalAmount = 'totalTooLow';
  }
  if (values.methods.length === 0) problems.methods = 'required';
  else if (values.side === 'sell' && !values.acceptsNonInstant && values.methods.some((method) => nonInstant.has(method.toLowerCase())))
    problems.methods = 'nonInstantConsent';
  if (values.terms.length > 4000) problems.terms = 'tooLong';
  return problems;
}

/** Fields that differ from the offer being edited, so a review can say what would change. */
export function offerChanges(before: OfferFormValues, after: OfferFormValues): OfferFormField[] {
  const changed: OfferFormField[] = [];
  const same = (a: string, b: string) => {
    const x = exact(a);
    const y = exact(b);
    return x !== null && y !== null ? x === y : a.trim() === b.trim();
  };
  if (before.asset !== after.asset.trim().toUpperCase()) changed.push('asset');
  if (before.fiatCurrency !== after.fiatCurrency) changed.push('fiatCurrency');
  if (!same(before.price, after.price)) changed.push('price');
  if (!same(before.minAmount, after.minAmount)) changed.push('minAmount');
  if (!same(before.maxAmount, after.maxAmount)) changed.push('maxAmount');
  if (after.totalAmount.trim() !== '' && !same(before.totalAmount, after.totalAmount)) changed.push('totalAmount');
  if ([...before.methods].sort().join() !== [...after.methods].sort().join()) changed.push('methods');
  if (before.terms.trim() !== after.terms.trim()) changed.push('terms');
  return changed;
}
