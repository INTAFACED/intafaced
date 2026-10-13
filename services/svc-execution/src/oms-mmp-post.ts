/**
 * Post both sides of one MMP quote as one live parent.
 * Never leave a one-sided quote. If bid or ask is below owner MQQ, refuse
 * the whole post. Refuse if MQQ is blank. Sizes are caller-supplied ledger
 * amounts; this door never invents size and does not submit to matching.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client';

export type OmsMmpPostInput = Readonly<{
  /** Live parent identity for this two-sided quote. */
  parentClientOrderId?: string;
  quoteId?: string;
  symbol?: string;
  bidQuoteId?: string;
  askQuoteId?: string;
  /** Owner minimum quote quantity as a ledger decimal string. Blank refuses. */
  mqq: string | null | undefined;
  /** Bid size as a ledger decimal string. Blank refuses. */
  bidSize: string | null | undefined;
  /** Ask size as a ledger decimal string. Blank refuses. */
  askSize: string | null | undefined;
}>;

export type OmsMmpPostRefuseReason =
  'missing_parent' | 'missing_quote_id' | 'mqq_blank' | 'mqq_invalid' | 'size_blank' | 'size_invalid' | 'one_sided';

export type OmsMmpPostRefusal = {
  readonly ok: false;
  readonly reason: OmsMmpPostRefuseReason;
  readonly detail: string;
};

export type OmsMmpPostAccepted = {
  readonly ok: true;
  readonly posted: true;
  readonly parent: { readonly parentClientOrderId: string };
  readonly quoteId: string;
  readonly symbol: string;
  readonly bidQuoteId: string;
  readonly askQuoteId: string;
  /** Always both — MMP never posts a one-sided quote. */
  readonly sides: readonly ['bid', 'ask'];
  readonly mqq: string;
  readonly bidSize: string;
  readonly askSize: string;
};

export type OmsMmpPostResult = OmsMmpPostAccepted | OmsMmpPostRefusal;

function refuse(reason: OmsMmpPostRefuseReason, detail: string): OmsMmpPostRefusal {
  return { ok: false, reason, detail };
}

function parseOwnerMqq(raw: string | null | undefined): { ok: true; value: Amount; text: string } | OmsMmpPostRefusal {
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

function parseSize(raw: string | null | undefined, label: string): { ok: true; value: Amount; text: string } | OmsMmpPostRefusal {
  if (raw === null || raw === undefined) {
    return refuse('size_blank', `${label} is blank — refuse rather than invent size`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('size_blank', `${label} is blank — refuse rather than invent size`);
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('size_invalid', `${label} must be a positive ledger amount — not invented`);
    }
    return { ok: true, value, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('size_invalid', `${label} is not a ledger amount: ${message}`);
  }
}

/**
 * Post bid and ask together as one live MMP parent.
 * Below-MQQ on either side refuses the whole post — never a one-sided leftover.
 * quoteId / bidQuoteId / askQuoteId are caller-supplied; this door does not invent ids.
 */
export function postBothSidesMmpQuote(input: OmsMmpPostInput): OmsMmpPostResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required — MMP quote posts as one live parent');
  }
  const quoteId = input.quoteId?.trim() ?? '';
  const bidQuoteId = input.bidQuoteId?.trim() ?? '';
  const askQuoteId = input.askQuoteId?.trim() ?? '';
  if (!quoteId) {
    return refuse('missing_quote_id', 'quoteId is required — ids are not invented');
  }
  if (!bidQuoteId) {
    return refuse('missing_quote_id', 'bidQuoteId is required — ids are not invented');
  }
  if (!askQuoteId) {
    return refuse('missing_quote_id', 'askQuoteId is required — ids are not invented');
  }
  const symbol = input.symbol?.trim() ?? '';

  const mqq = parseOwnerMqq(input.mqq);
  if (!mqq.ok) return mqq;
  const bid = parseSize(input.bidSize, 'bidSize');
  if (!bid.ok) return bid;
  const ask = parseSize(input.askSize, 'askSize');
  if (!ask.ok) return ask;

  if (bid.value < mqq.value || ask.value < mqq.value) {
    return refuse('one_sided', 'bid or ask is below MQQ — refusing rather than post a one-sided MMP quote');
  }

  return {
    ok: true,
    posted: true,
    parent: { parentClientOrderId },
    quoteId,
    symbol,
    bidQuoteId,
    askQuoteId,
    sides: ['bid', 'ask'],
    mqq: mqq.text,
    bidSize: bid.text,
    askSize: ask.text,
  };
}
