/**
 * Pure rules for the person-to-person rooms: order buckets, the escrow path of an order, time left, what a take would
 * cost before fees, offer filters, and offer-form checks. No React, no network. Money is exact decimals.
 */
import { dec, str, times } from '../../../data/decimal';
import type { Offer, Trade } from '../schemas';

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
  if (
    role !== 'observer' &&
    (trade.status === 'created' || trade.status === 'escrowed' || (trade.status === 'fiat_sent' && role === 'seller'))
  )
    actions.push('cancel');
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

/** Keep offers that take the chosen payment method, and, if asked, only one person's offers. */
export function filterOffers<T extends Pick<Offer, 'methods' | 'makerId'>>(
  rows: readonly T[],
  filter: { method?: string; makerId?: string },
): T[] {
  return rows.filter(
    (offer) =>
      (!filter.method || offerMethodIds(offer).includes(filter.method)) &&
      (!filter.makerId || offer.makerId.toLowerCase() === filter.makerId.toLowerCase()),
  );
}

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
}

export type OfferFormField = 'asset' | 'fiatCurrency' | 'price' | 'minAmount' | 'maxAmount' | 'totalAmount' | 'methods' | 'terms';
export type OfferFormProblem = 'required' | 'invalid' | 'minTooHigh' | 'totalTooLow' | 'tooLong';

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
});

const exact = (value: string): bigint | null => {
  const text = value.trim();
  return /^\d+(\.\d{1,18})?$/.test(text) ? dec(text) : null;
};

/** Every problem with the form, by field. An empty object means the form is complete. */
export function checkOfferForm(values: OfferFormValues): Partial<Record<OfferFormField, OfferFormProblem>> {
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
