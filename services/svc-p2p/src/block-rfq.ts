/**
 * P2P block / RFQ (PTX-M12).
 *
 * A firm bilateral quote is not a book fill. The maker names size, price,
 * expiry, capacity and firmness; this service never sources or invents a mid
 * or the house model. Last look / undisclosed last look / a quote that is
 * not firm until expiry refuses with a named code. Accept honours the quoted
 * price. Expire refuses rather than requote. Give-up/allocation without a
 * named receiving account refuses — never invent maker, taker, house or
 * omnibus. Named still refuse-closed until owner law exists.
 */

import { randomUUID } from 'node:crypto';
import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { isSupportedFiat } from '@intafaced/config';
import type { Principal } from '@intafaced/auth';
import type { BlockQuoteStore } from './block-rfq-store.js';

export type BlockRfqErrorCode =
  | 'p2p.rfq_missing_size'
  | 'p2p.rfq_missing_price'
  | 'p2p.rfq_missing_expiry'
  | 'p2p.rfq_invalid_size'
  | 'p2p.rfq_invalid_price'
  | 'p2p.rfq_invalid_expiry'
  | 'p2p.rfq_self_trade'
  | 'p2p.rfq_not_found'
  | 'p2p.rfq_not_a_party'
  | 'p2p.rfq_expired'
  | 'p2p.rfq_already_bound'
  | 'p2p.rfq_last_look_forbidden'
  | 'p2p.rfq_unlabeled_capacity'
  | 'p2p.rfq_unnamed_receiving_account'
  | 'p2p.rfq_allocation_refused'
  | 'p2p.rfq_give_up_refused'
  | 'p2p.trading_disabled';

export class BlockRfqError extends Error {
  constructor(
    message: string,
    readonly code: BlockRfqErrorCode,
    readonly residual?: string,
  ) {
    super(message);
    this.name = 'BlockRfqError';
  }
}

export const RFQ_UNNAMED_RECEIVING_RESIDUAL =
  'PTX-M12-R04/R08 receiving account is caller-named — refuse-closed; never invent maker, taker, house, omnibus or a carrying plug';

export const RFQ_ALLOCATION_RESIDUAL =
  'PTX-M12-R04/R08 allocation, sub-accounts, average-price and bunched breaks are owner law — refuse-closed; never invent a split';

export const RFQ_GIVE_UP_RESIDUAL =
  'PTX-M12-R08 give-up, carrying account, affirmation and settlement instruction are owner law — refuse-closed; never invent a clearing map';

export const RFQ_LAST_LOOK_RESIDUAL =
  'PTX-M12-R02 quotes are firm until expiry — last look and undisclosed last look are forbidden; never silently requote';

export const RFQ_UNLABELED_CAPACITY_RESIDUAL =
  'PTX-M12-R01 principal, matched-principal and agency must be labeled on the quote — refuse-closed; never invent which model the house is';

/** Caller must name the receiving account. Blank/missing refuses — never invent. */
export function parseNamedReceivingAccount(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) {
    throw new BlockRfqError(
      'Give-up/allocation without a named receiving account is refused — never invent maker, taker, house or omnibus',
      'p2p.rfq_unnamed_receiving_account',
      RFQ_UNNAMED_RECEIVING_RESIDUAL,
    );
  }
  return s;
}

export type BlockRfqSide = 'buy' | 'sell';
export type BlockQuoteLifecycle = 'open' | 'bound' | 'expired';
/** Caller-labeled. Never defaulted to principal. */
export type BlockQuoteCapacity = 'principal' | 'matched_principal' | 'agency';
/** Only firm-until-expiry is allowed. Indicative / last-look refuse. */
export type BlockQuoteFirmness = 'firm';

const CAPACITIES = new Set<BlockQuoteCapacity>(['principal', 'matched_principal', 'agency']);

function lastLookSignal(raw: boolean | string | null | undefined): boolean {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return s === 'true' || s === 'yes' || s === '1' || s === 'undisclosed' || s === 'last_look';
}

/** Last look, undisclosed last look, or not-firm-until-expiry — named refuse, never silent. */
export function parseRequiredFirmness(input: { firmness?: string | null; lastLook?: boolean | string | null }): BlockQuoteFirmness {
  if (lastLookSignal(input.lastLook)) {
    throw new BlockRfqError(
      'Last look is forbidden — a block/RFQ quote must be firm until expiry',
      'p2p.rfq_last_look_forbidden',
      RFQ_LAST_LOOK_RESIDUAL,
    );
  }
  const s = (input.firmness ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (!s) {
    throw new BlockRfqError(
      'Undisclosed last look is forbidden — a block/RFQ quote must be labeled firm until expiry',
      'p2p.rfq_last_look_forbidden',
      RFQ_LAST_LOOK_RESIDUAL,
    );
  }
  if (s !== 'firm') {
    throw new BlockRfqError(
      'A quote that is not firm until expiry is last look — refused',
      'p2p.rfq_last_look_forbidden',
      RFQ_LAST_LOOK_RESIDUAL,
    );
  }
  return 'firm';
}

/** Principal / matched-principal / agency must be labeled. Never invent the house model. */
export function parseRequiredCapacity(raw: string | null | undefined): BlockQuoteCapacity {
  const s = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (!s || !CAPACITIES.has(s as BlockQuoteCapacity)) {
    throw new BlockRfqError(
      'Block/RFQ capacity must be labeled principal, matched_principal or agency — never invent which model the house is',
      'p2p.rfq_unlabeled_capacity',
      RFQ_UNLABELED_CAPACITY_RESIDUAL,
    );
  }
  return s as BlockQuoteCapacity;
}

export interface BlockQuote {
  readonly quoteId: string;
  readonly makerId: string;
  readonly takerId: string;
  readonly side: BlockRfqSide;
  readonly asset: string;
  readonly fiatCurrency: string;
  readonly size: Amount;
  readonly price: Amount;
  readonly notional: Amount;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lifecycle: BlockQuoteLifecycle;
  readonly acceptedAt: string | null;
  readonly fillPrice: Amount | null;
  readonly capacity: BlockQuoteCapacity;
  readonly firmness: BlockQuoteFirmness;
  /** Bound quotes are firm accepts, never matching-engine fills. */
  readonly bookFill: false;
}

export interface BlockQuoteWire {
  readonly quoteId: string;
  readonly makerId: string;
  readonly takerId: string;
  readonly side: BlockRfqSide;
  readonly asset: string;
  readonly fiatCurrency: string;
  readonly size: string;
  readonly price: string;
  readonly notional: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lifecycle: BlockQuoteLifecycle;
  readonly acceptedAt: string | null;
  readonly fillPrice: string | null;
  readonly capacity: BlockQuoteCapacity;
  readonly firmness: BlockQuoteFirmness;
  readonly lastLook: false;
  readonly bookFill: false;
  readonly midInvented: false;
}

export function parseRequiredSize(raw: string | null | undefined): Amount {
  const s = (raw ?? '').trim();
  if (!s) {
    throw new BlockRfqError('Block/RFQ size is required — refuse rather than invent', 'p2p.rfq_missing_size');
  }
  try {
    const size = parseAmount(s);
    if (size <= 0n) {
      throw new BlockRfqError('Block/RFQ size must be strictly positive', 'p2p.rfq_invalid_size');
    }
    return size;
  } catch (err) {
    if (err instanceof BlockRfqError) throw err;
    throw new BlockRfqError('Block/RFQ size is not a valid decimal string', 'p2p.rfq_invalid_size');
  }
}

export function parseRequiredPrice(raw: string | null | undefined): Amount {
  const s = (raw ?? '').trim();
  if (!s) {
    throw new BlockRfqError('Block/RFQ price is required — refuse rather than invent a mid', 'p2p.rfq_missing_price');
  }
  try {
    const price = parseAmount(s);
    if (price <= 0n) {
      throw new BlockRfqError('Block/RFQ price must be strictly positive — refuse rather than invent a mid', 'p2p.rfq_invalid_price');
    }
    return price;
  } catch (err) {
    if (err instanceof BlockRfqError) throw err;
    throw new BlockRfqError('Block/RFQ price is not a valid decimal string — refuse rather than invent a mid', 'p2p.rfq_invalid_price');
  }
}

export function parseRequiredExpiry(raw: string | null | undefined, now: Date): Date {
  const s = (raw ?? '').trim();
  if (!s) {
    throw new BlockRfqError('Block/RFQ expiry is required — refuse rather than invent a TTL', 'p2p.rfq_missing_expiry');
  }
  const at = Date.parse(s);
  if (!Number.isFinite(at)) {
    throw new BlockRfqError('Block/RFQ expiry is not a usable timestamp', 'p2p.rfq_invalid_expiry');
  }
  if (at <= now.getTime()) {
    throw new BlockRfqError('Block/RFQ expiry must be in the future — refuse rather than invent a TTL', 'p2p.rfq_invalid_expiry');
  }
  return new Date(at);
}

export function presentBlockQuote(q: BlockQuote): BlockQuoteWire {
  return {
    quoteId: q.quoteId,
    makerId: q.makerId,
    takerId: q.takerId,
    side: q.side,
    asset: q.asset,
    fiatCurrency: q.fiatCurrency,
    size: formatAmount(q.size),
    price: formatAmount(q.price),
    notional: formatAmount(q.notional),
    createdAt: q.createdAt,
    expiresAt: q.expiresAt,
    lifecycle: q.lifecycle,
    acceptedAt: q.acceptedAt,
    fillPrice: q.fillPrice == null ? null : formatAmount(q.fillPrice),
    capacity: parseRequiredCapacity(q.capacity),
    firmness: parseRequiredFirmness({ firmness: q.firmness }),
    lastLook: false,
    bookFill: false,
    midInvented: false,
  };
}

export function buildBlockQuote(input: {
  quoteId: string;
  makerId: string;
  takerId: string;
  side: BlockRfqSide;
  asset: string;
  fiatCurrency: string;
  size: Amount;
  price: Amount;
  now: Date;
  expiresAt: Date;
  capacity: BlockQuoteCapacity;
  firmness: BlockQuoteFirmness;
}): BlockQuote {
  if (input.makerId === input.takerId) {
    throw new BlockRfqError('A block/RFQ cannot be quoted to yourself', 'p2p.rfq_self_trade');
  }
  const notional = mul(input.price, input.size, 'floor');
  if (notional <= 0n) {
    throw new BlockRfqError('Block/RFQ notional must be strictly positive', 'p2p.rfq_invalid_size');
  }
  return {
    quoteId: input.quoteId,
    makerId: input.makerId,
    takerId: input.takerId,
    side: input.side,
    asset: input.asset,
    fiatCurrency: input.fiatCurrency,
    size: input.size,
    price: input.price,
    notional,
    createdAt: input.now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    lifecycle: 'open',
    acceptedAt: null,
    fillPrice: null,
    capacity: input.capacity,
    firmness: input.firmness,
    bookFill: false,
  };
}

export function acceptBlockQuote(input: { quote: BlockQuote; now: Date; assertedPrice?: Amount | null }): BlockQuote {
  if (input.quote.lifecycle === 'expired' || Date.parse(input.quote.expiresAt) < input.now.getTime()) {
    throw new BlockRfqError('Block/RFQ quote expired — refuse rather than requote', 'p2p.rfq_expired');
  }
  if (input.quote.lifecycle === 'bound') {
    if (input.assertedPrice != null && input.assertedPrice !== input.quote.price) {
      throw new BlockRfqError('Last look is not permitted — accept must honour the quoted price', 'p2p.rfq_last_look_forbidden');
    }
    return input.quote;
  }
  if (input.assertedPrice != null && input.assertedPrice !== input.quote.price) {
    throw new BlockRfqError('Last look is not permitted — accept must honour the quoted price', 'p2p.rfq_last_look_forbidden');
  }
  return {
    ...input.quote,
    lifecycle: 'bound',
    acceptedAt: input.now.toISOString(),
    fillPrice: input.quote.price,
    bookFill: false,
  };
}

export function expireBlockQuote(input: { quote: BlockQuote; now: Date }): BlockQuote {
  if (input.quote.lifecycle === 'bound') {
    throw new BlockRfqError('A bound block/RFQ cannot expire — that would unwind a firm accept into a book fill', 'p2p.rfq_already_bound');
  }
  if (input.quote.lifecycle === 'expired') return input.quote;
  return { ...input.quote, lifecycle: 'expired', acceptedAt: null, fillPrice: null, bookFill: false };
}

export class BlockRfqService {
  private readonly now: () => Date;
  private readonly isTradingEnabled: () => boolean;

  constructor(
    private readonly store: BlockQuoteStore,
    options: { now?: () => Date; isTradingEnabled?: () => boolean } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.isTradingEnabled = options.isTradingEnabled ?? (() => true);
  }

  private assertLive(): void {
    if (!this.isTradingEnabled()) {
      throw new BlockRfqError('P2P trading is disabled — new block/RFQ quotes are refused', 'p2p.trading_disabled');
    }
  }

  async quote(
    principal: Principal,
    input: {
      takerId: string;
      side: BlockRfqSide;
      asset: string;
      fiatCurrency: string;
      size: string;
      price: string;
      expiresAt: string;
      capacity?: string | null;
      firmness?: string | null;
      lastLook?: boolean | string | null;
    },
  ): Promise<BlockQuoteWire> {
    this.assertLive();
    const fiatCurrency = input.fiatCurrency.trim().toUpperCase();
    if (!isSupportedFiat(fiatCurrency)) {
      throw new BlockRfqError(`Unsupported fiat currency "${input.fiatCurrency}"`, 'p2p.rfq_invalid_price');
    }
    const asset = input.asset.trim();
    if (!asset) {
      throw new BlockRfqError('Block/RFQ asset is required', 'p2p.rfq_invalid_size');
    }
    const now = this.now();
    const quote = buildBlockQuote({
      quoteId: randomUUID(),
      makerId: principal.userId,
      takerId: input.takerId.trim(),
      side: input.side,
      asset,
      fiatCurrency,
      size: parseRequiredSize(input.size),
      price: parseRequiredPrice(input.price),
      now,
      expiresAt: parseRequiredExpiry(input.expiresAt, now),
      capacity: parseRequiredCapacity(input.capacity),
      firmness: parseRequiredFirmness({ firmness: input.firmness, lastLook: input.lastLook }),
    });
    await this.store.save(quote);
    return presentBlockQuote(quote);
  }

  async accept(principal: Principal, input: { quoteId: string; assertedPrice?: string }): Promise<BlockQuoteWire> {
    this.assertLive();
    const stored = await this.requireQuote(input.quoteId);
    if (stored.makerId !== principal.userId && stored.takerId !== principal.userId) {
      throw new BlockRfqError('Block/RFQ quote not found', 'p2p.rfq_not_found');
    }
    if (stored.takerId !== principal.userId) {
      throw new BlockRfqError('Only the named taker may accept a block/RFQ', 'p2p.rfq_not_a_party');
    }
    let asserted: Amount | null = null;
    if (input.assertedPrice != null && input.assertedPrice.trim() !== '') {
      asserted = parseRequiredPrice(input.assertedPrice);
    }
    const bound = acceptBlockQuote({ quote: stored, now: this.now(), assertedPrice: asserted });
    if (bound !== stored) await this.store.save(bound);
    return presentBlockQuote(bound);
  }

  async expire(principal: Principal, input: { quoteId: string }): Promise<BlockQuoteWire> {
    const stored = await this.requireQuote(input.quoteId);
    if (stored.makerId !== principal.userId && stored.takerId !== principal.userId) {
      throw new BlockRfqError('Block/RFQ quote not found', 'p2p.rfq_not_found');
    }
    const expired = expireBlockQuote({ quote: stored, now: this.now() });
    if (expired !== stored) await this.store.save(expired);
    return presentBlockQuote(expired);
  }

  async get(principal: Principal, quoteId: string): Promise<BlockQuoteWire> {
    const stored = await this.requireQuote(quoteId);
    if (stored.makerId !== principal.userId && stored.takerId !== principal.userId) {
      throw new BlockRfqError('Block/RFQ quote not found', 'p2p.rfq_not_found');
    }
    return presentBlockQuote(stored);
  }

  allocate(_principal: Principal, input: { quoteId: string; allocations?: ReadonlyArray<{ receivingAccount?: string | null }> }): never {
    const lines = input.allocations ?? [];
    if (lines.length === 0) {
      parseNamedReceivingAccount(undefined);
    }
    for (const line of lines) {
      parseNamedReceivingAccount(line.receivingAccount);
    }
    throw new BlockRfqError(
      'Block/RFQ allocation is refuse-closed until owner law names sub-accounts, average price and breaks — never invent a split',
      'p2p.rfq_allocation_refused',
      RFQ_ALLOCATION_RESIDUAL,
    );
  }

  giveUp(_principal: Principal, input: { quoteId: string; receivingAccount?: string | null }): never {
    parseNamedReceivingAccount(input.receivingAccount);
    throw new BlockRfqError(
      'Block/RFQ give-up is refuse-closed until owner law names carrying account, affirmation and settlement instruction — never invent a clearing map',
      'p2p.rfq_give_up_refused',
      RFQ_GIVE_UP_RESIDUAL,
    );
  }

  private async requireQuote(quoteId: string): Promise<BlockQuote> {
    const stored = await this.store.load(quoteId);
    if (!stored) {
      throw new BlockRfqError('Block/RFQ quote not found', 'p2p.rfq_not_found');
    }
    return stored;
  }
}
