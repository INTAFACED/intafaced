/**
 * OTC RFQ quote math + accept (SPEC-OTC-RFQ-AND-EARN Part A).
 *
 * - Quote discloses counterparty, size, expiry, and house spread.
 * - Mid is server-sourced (`mid-source.ts`) — never invented, and never taken
 *   from the caller: see that file for why those are the same rule.
 * - Accept binds the quoted price; requote / last-look is forbidden.
 */

import { div, formatAmount, mul, mulBps, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import type { OtcCounterpartyMode } from './desk-law.js';
import { OtcError } from './errors.js';

export type OtcSide = 'buy' | 'sell';

export interface OtcQuoteInput {
  readonly quoteId: string;
  readonly userId: string;
  readonly side: OtcSide;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly qty: Amount;
  /** Desk reference mid, resolved server-side. Never the caller's number. */
  readonly midPrice: Amount;
  readonly spreadBps: number;
  readonly counterparty: OtcCounterpartyMode;
  /** Counterparty label shown to the user (platform id or maker id). */
  readonly counterpartyId: string;
  readonly now: Date;
  readonly quoteTtlMs: number;
  /** The request this quote answers; one request asks several providers (#5). Left out: the quote is its own request. */
  readonly rfqId?: string;
  /** This quote's place in its request, from 1, in the order the providers were asked: a tie goes to the lower. */
  readonly rfqSeq?: number;
  /** The provider that quoted, from the owner's list; null for a convert, which asks no provider. */
  readonly makerId?: string | null;
  /** True when the price comes from a LOCAL TEST spread: the room labels it TEST. */
  readonly test?: boolean;
}

export interface OtcQuote {
  readonly quoteId: string;
  readonly userId: string;
  readonly side: OtcSide;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly qty: Amount;
  readonly midPrice: Amount;
  readonly quotedPrice: Amount;
  readonly midNotional: Amount;
  readonly userNotional: Amount;
  readonly spreadBps: number;
  readonly spreadNotional: Amount;
  readonly counterparty: OtcCounterpartyMode;
  readonly counterpartyId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: 'open';
  readonly rfqId: string;
  readonly rfqSeq: number;
  readonly makerId: string | null;
  readonly test: boolean;
}

export interface BoundOtcFill {
  readonly quoteId: string;
  readonly userId: string;
  readonly side: OtcSide;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly qty: Amount;
  readonly fillPrice: Amount;
  readonly fillNotional: Amount;
  readonly spreadBps: number;
  readonly counterparty: OtcCounterpartyMode;
  readonly counterpartyId: string;
  readonly acceptedAt: string;
}

export function buildOtcQuote(input: OtcQuoteInput): OtcQuote {
  if (input.qty <= 0n) {
    throw new OtcError('OTC quantity must be strictly positive', 'trade.otc_invalid_qty');
  }
  if (input.midPrice <= 0n) {
    throw new OtcError('OTC mid price must be strictly positive — refuse rather than invent', 'trade.otc_no_reference_price');
  }
  if (input.spreadBps < 0 || input.spreadBps > 5000) {
    throw new OtcError('OTC spread bps out of range', 'trade.otc_bad_spread');
  }
  if (!input.counterpartyId.trim()) {
    throw new OtcError('OTC counterparty id is required for disclosure', 'trade.otc_no_reference_price');
  }

  const midNotional = mul(input.midPrice, input.qty, 'floor');
  const spreadNotional = mulBps(midNotional, input.spreadBps, 'ceil');
  const userNotional =
    input.side === 'buy' ? midNotional + spreadNotional : midNotional > spreadNotional ? sub(midNotional, spreadNotional) : 0n;

  if (userNotional <= 0n) {
    throw new OtcError('OTC spread consumes the entire notional', 'trade.otc_bad_spread');
  }

  // VWAP after spread: buy ceil, sell floor (same honesty as convert).
  //
  // `div`, not `/`. Both operands are SCALED bigints, so raw bigint division
  // cancels the scale and returns the ratio 1e18 times too small: a 1 BTC buy
  // quoted off a mid of 200 came back as `0.000000000000000201` rather than
  // `201`. It never moved the wrong amount — settle pays `fillNotional`, which
  // was always right — but the price ON THE QUOTE is the number the customer
  // decides against, and A4.1 requires the quote to state it. A desk that
  // charges 201 while printing 0.000000000000000201 has not quoted a price.
  const quotedPrice = div(userNotional, input.qty, input.side === 'buy' ? 'ceil' : 'floor');

  const expires = new Date(input.now.getTime() + input.quoteTtlMs);

  return {
    quoteId: input.quoteId,
    userId: input.userId,
    side: input.side,
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    qty: input.qty,
    midPrice: input.midPrice,
    quotedPrice,
    midNotional,
    userNotional,
    spreadBps: input.spreadBps,
    spreadNotional,
    counterparty: input.counterparty,
    counterpartyId: input.counterpartyId.trim(),
    createdAt: input.now.toISOString(),
    expiresAt: expires.toISOString(),
    status: 'open',
    rfqId: input.rfqId ?? input.quoteId,
    rfqSeq: input.rfqSeq ?? 1,
    makerId: input.makerId ?? null,
    test: input.test === true,
  };
}

/**
 * Accept an unexpired quote at the **quoted** price.
 * Passing a different price is last-look — forbidden.
 */
export function acceptOtcQuote(input: {
  quote: OtcQuote;
  now: Date;
  /** If supplied, must equal quote.quotedPrice — else last-look refuse. */
  assertedPrice?: Amount | null;
}): BoundOtcFill {
  const expiresAt = Date.parse(input.quote.expiresAt);
  if (!Number.isFinite(expiresAt) || input.now.getTime() > expiresAt) {
    throw new OtcError('OTC quote expired — refuse rather than requote', 'trade.otc_quote_expired');
  }

  if (input.assertedPrice != null && input.assertedPrice !== input.quote.quotedPrice) {
    throw new OtcError('Last look is not permitted — accept must honour the quoted price', 'trade.otc_last_look_forbidden');
  }

  return {
    quoteId: input.quote.quoteId,
    userId: input.quote.userId,
    side: input.quote.side,
    baseAsset: input.quote.baseAsset,
    quoteAsset: input.quote.quoteAsset,
    qty: input.quote.qty,
    fillPrice: input.quote.quotedPrice,
    fillNotional: input.quote.userNotional,
    spreadBps: input.quote.spreadBps,
    counterparty: input.quote.counterparty,
    counterpartyId: input.quote.counterpartyId,
    acceptedAt: input.now.toISOString(),
  };
}

export function presentOtcQuote(q: OtcQuote) {
  return {
    quoteId: q.quoteId,
    side: q.side,
    baseAsset: q.baseAsset,
    quoteAsset: q.quoteAsset,
    qty: formatAmount(q.qty),
    midPrice: formatAmount(q.midPrice),
    quotedPrice: formatAmount(q.quotedPrice),
    midNotional: formatAmount(q.midNotional),
    userNotional: formatAmount(q.userNotional),
    spreadBps: q.spreadBps,
    spreadNotional: formatAmount(q.spreadNotional),
    counterparty: q.counterparty,
    counterpartyId: q.counterpartyId,
    createdAt: q.createdAt,
    expiresAt: q.expiresAt,
    status: q.status,
    rfqId: q.rfqId,
    rfqSeq: q.rfqSeq,
    makerId: q.makerId,
    test: q.test,
  };
}

/**
 * The quotes of one request, best first: for a buy the lowest price, for a sell the highest. Equal prices go to the
 * quote asked earlier (lower rfqSeq), never to whichever row came back first.
 */
export function rankRfqQuotes<T extends Pick<OtcQuote, 'side' | 'quotedPrice' | 'rfqSeq'>>(quotes: readonly T[]): T[] {
  return [...quotes].sort((a, b) => {
    if (a.quotedPrice !== b.quotedPrice) {
      const lower = a.quotedPrice < b.quotedPrice ? -1 : 1;
      return a.side === 'buy' ? lower : -lower;
    }
    return a.rfqSeq - b.rfqSeq;
  });
}

export function presentBoundOtcFill(f: BoundOtcFill) {
  return {
    quoteId: f.quoteId,
    side: f.side,
    baseAsset: f.baseAsset,
    quoteAsset: f.quoteAsset,
    qty: formatAmount(f.qty),
    fillPrice: formatAmount(f.fillPrice),
    fillNotional: formatAmount(f.fillNotional),
    spreadBps: f.spreadBps,
    counterparty: f.counterparty,
    counterpartyId: f.counterpartyId,
    acceptedAt: f.acceptedAt,
  };
}

/** Blank size is not a quote — never invent quantity. */
export function parseRequiredOtcSize(raw: string | null | undefined): Amount {
  const s = (raw ?? '').trim();
  if (!s) {
    throw new OtcError('Professional RFQ size is required — refuse rather than invent', 'trade.rfq_missing_size');
  }
  try {
    const qty = parseAmount(s);
    if (qty <= 0n) {
      throw new OtcError('OTC quantity must be strictly positive', 'trade.otc_invalid_qty');
    }
    return qty;
  } catch (err) {
    if (err instanceof OtcError) throw err;
    throw new OtcError('Professional RFQ size is not a valid decimal string', 'trade.otc_invalid_qty');
  }
}

/** Blank price is not a quote — never invent a mid. */
export function parseRequiredOtcPrice(raw: string | null | undefined): Amount {
  const s = (raw ?? '').trim();
  if (!s) {
    throw new OtcError('Professional RFQ price is required — refuse rather than invent a mid', 'trade.rfq_missing_price');
  }
  try {
    const px = parseAmount(s);
    if (px <= 0n) {
      throw new OtcError('OTC mid price must be strictly positive', 'trade.otc_invalid_price');
    }
    return px;
  } catch (err) {
    if (err instanceof OtcError) throw err;
    throw new OtcError('Professional RFQ price is not a valid decimal string — refuse rather than invent a mid', 'trade.otc_invalid_price');
  }
}

export type FirmRfqLifecycle = 'open' | 'bound' | 'expired' | 'settled';

export function expireOtcQuote(input: { lifecycle: FirmRfqLifecycle }): FirmRfqLifecycle {
  if (input.lifecycle === 'bound' || input.lifecycle === 'settled') {
    throw new OtcError(
      'A bound professional RFQ cannot expire — that would unwind a firm accept into a book fill',
      'trade.rfq_already_bound',
    );
  }
  return 'expired';
}

export function presentFirmRfq(
  q: OtcQuote,
  extras: {
    lifecycle: FirmRfqLifecycle;
    acceptedAt?: string | null;
    fillPrice?: Amount | null;
    /** When a bound quote stops settling: the owner window from the accept, or the quote's expiry when it is blank. */
    settleBy?: string | null;
    /** The owner's deferred-settle window in ms; null when it is blank ("Not set": no deferral past the expiry). */
    settleWindowMs?: number | null;
  },
) {
  return {
    ...presentOtcQuote(q),
    lifecycle: extras.lifecycle,
    acceptedAt: extras.acceptedAt ?? null,
    fillPrice: extras.fillPrice == null ? null : formatAmount(extras.fillPrice),
    settleBy: extras.settleBy ?? null,
    settleWindowMs: extras.settleWindowMs ?? null,
    bookFill: false as const,
    midInvented: false as const,
  };
}

/** Parse mid from wire; blank → no_reference_price (never invent zero). */
export function parseOtcMidPrice(raw: string | null | undefined): Amount {
  const s = (raw ?? '').trim();
  if (!s) {
    throw new OtcError('OTC mid price required — refuse rather than invent', 'trade.otc_no_reference_price');
  }
  try {
    const px = parseAmount(s);
    if (px <= 0n) {
      throw new OtcError('OTC mid price must be strictly positive', 'trade.otc_invalid_price');
    }
    return px;
  } catch (err) {
    if (err instanceof OtcError) throw err;
    throw new OtcError('OTC mid price is not a valid amount', 'trade.otc_invalid_price');
  }
}
