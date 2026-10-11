/**
 * MMP: cancel both sides of one two-sided MM quote when MQQ is breached.
 *
 * Owner MQQ is the minimum remaining quote quantity. If remaining on the
 * bid or the ask is below MQQ, cancel BOTH sides of that quote — never a
 * one-sided leftover. Refuse if MQQ is blank. Remaining sizes are caller-
 * supplied ledger amounts; this door never invents size and does not
 * submit to matching or flatten positions.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client';

export type OmsMmpMqqLiveQuote = Readonly<{
  quoteId: string;
  symbol: string;
  bidQuoteId: string;
  askQuoteId: string;
  /** Remaining bid size as a ledger decimal string. Blank refuses. */
  bidRemaining: string;
  /** Remaining ask size as a ledger decimal string. Blank refuses. */
  askRemaining: string;
}>;

export type OmsMmpMqqInput = Readonly<{
  /** Owner minimum quote quantity as a ledger decimal string. Blank refuses. */
  mqq: string | null | undefined;
  quotes: readonly OmsMmpMqqLiveQuote[];
}>;

export type OmsMmpMqqCancelled = Readonly<{
  quoteId: string;
  symbol: string;
  bidQuoteId: string;
  askQuoteId: string;
  /** Always both — MMP never leaves a one-sided quote. */
  sides: readonly ['bid', 'ask'];
  bidRemaining: string;
  askRemaining: string;
}>;

export type OmsMmpMqqRefuseReason = 'mqq_blank' | 'mqq_invalid' | 'remaining_blank' | 'remaining_invalid';

export type OmsMmpMqqRefusal = {
  readonly ok: false;
  readonly reason: OmsMmpMqqRefuseReason;
  readonly detail: string;
};

export type OmsMmpMqqAccepted = {
  readonly ok: true;
  readonly mqq: string;
  readonly cancelled: readonly OmsMmpMqqCancelled[];
  readonly leftStanding: readonly OmsMmpMqqLiveQuote[];
};

export type OmsMmpMqqResult = OmsMmpMqqAccepted | OmsMmpMqqRefusal;

function refuse(reason: OmsMmpMqqRefuseReason, detail: string): OmsMmpMqqRefusal {
  return { ok: false, reason, detail };
}

function parseOwnerMqq(raw: string | null | undefined): { ok: true; value: Amount; text: string } | OmsMmpMqqRefusal {
  if (raw === null || raw === undefined) {
    return refuse('mqq_blank', 'MQQ is blank — refuse rather than invent a minimum quote quantity');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('mqq_blank', 'MQQ is blank — refuse rather than invent a minimum quote quantity');
  }
  try {
    const value = parseAmount(text);
    if (value < 0n) {
      return refuse('mqq_invalid', 'MQQ must be a non-negative ledger amount — not invented');
    }
    return { ok: true, value, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('mqq_invalid', `MQQ is not a ledger amount: ${message}`);
  }
}

function parseRemaining(raw: unknown, label: string): { ok: true; value: Amount } | OmsMmpMqqRefusal {
  if (raw === null || raw === undefined) {
    return refuse('remaining_blank', `${label} is blank — refuse rather than invent remaining size`);
  }
  if (typeof raw !== 'string') {
    return refuse('remaining_invalid', `${label} is not a ledger amount — refuse rather than invent remaining size`);
  }
  if (raw.trim().length === 0) {
    return refuse('remaining_blank', `${label} is blank — refuse rather than invent remaining size`);
  }
  try {
    const value = parseAmount(raw);
    if (value < 0n) {
      return refuse('remaining_invalid', `${label} must be a non-negative ledger amount — not invented`);
    }
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('remaining_invalid', `${label} is not a ledger amount: ${message}`);
  }
}

/**
 * Plan cancel of both sides when remaining bid or ask is below owner MQQ.
 * Quotes at or above MQQ on both sides stay in leftStanding.
 * Does not submit to matching and does not flatten.
 */
export function cancelBothSidesOnMqqBreach(input: OmsMmpMqqInput): OmsMmpMqqResult {
  const mqq = parseOwnerMqq(input.mqq);
  if (!mqq.ok) return mqq;

  const cancelled: OmsMmpMqqCancelled[] = [];
  const leftStanding: OmsMmpMqqLiveQuote[] = [];

  for (const quote of input.quotes) {
    if (quote === null || typeof quote !== 'object') {
      return refuse('remaining_blank', 'quote is missing — refuse rather than invent remaining size');
    }
    const bid = parseRemaining(quote.bidRemaining, 'bidRemaining');
    if (!bid.ok) return bid;
    const ask = parseRemaining(quote.askRemaining, 'askRemaining');
    if (!ask.ok) return ask;

    if (bid.value < mqq.value || ask.value < mqq.value) {
      cancelled.push({
        quoteId: quote.quoteId,
        symbol: quote.symbol,
        bidQuoteId: quote.bidQuoteId,
        askQuoteId: quote.askQuoteId,
        sides: ['bid', 'ask'],
        bidRemaining: quote.bidRemaining,
        askRemaining: quote.askRemaining,
      });
    } else {
      leftStanding.push(quote);
    }
  }

  return { ok: true, mqq: mqq.text, cancelled, leftStanding };
}
