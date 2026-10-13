/**
 * OMS external arb scan door (D26-P1-X4) — wraps `@intafaced/execution-arb`.
 *
 * Caller supplies quotes, §28 cost terms, inventory, clock, and owner max age.
 * This module never invents mids, spreads, fees, or freshness windows.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  scanArbClass,
  type ArbOpportunity,
  type ArbRefusal,
  type ArbScanClass,
  type ArbVenueQuote,
  type ScanExternalArbResult,
} from '@intafaced/execution-arb';
import type { SorCostTerms, VenueKind } from '@intafaced/venue-adapter';

export type OmsArbQuoteInput = {
  readonly venueId: string;
  readonly kind: VenueKind;
  /**
   * Null stays null so the scanner can refuse a missing quote.
   * A blank or non-decimal string is a typed refusal at this door — never a throw, never a mid.
   */
  readonly price: string | null;
  readonly amount: string;
  /** Observation time (ms). Null = missing — refused as stale/missing. */
  readonly asOfMs: number | null;
};

export type OmsArbScanInput = {
  readonly symbol: string;
  readonly amount: string;
  readonly quotes: readonly OmsArbQuoteInput[];
  readonly costTermsByVenue: Readonly<Record<string, SorCostTerms>>;
  readonly inventory: { readonly prePositionedByVenue: Readonly<Record<string, boolean>> };
  readonly nowMs: number;
  /** Owner freshness window. Null → every quote stale (not invented). */
  readonly maxQuoteAgeMs: number | null;
  readonly scanClass?: ArbScanClass;
  readonly fundingRate?: string | null;
};

export type OmsArbOpportunityWire = {
  readonly ok: true;
  readonly symbol: string;
  readonly buyVenueId: string;
  readonly sellVenueId: string;
  readonly buyKind: VenueKind;
  readonly sellKind: VenueKind;
  readonly amount: string;
  readonly buyAllIn: string;
  readonly sellAllIn: string;
  readonly edgePerUnit: string;
  readonly buyCostBps: number;
  readonly sellCostBps: number;
};

export type OmsArbScanResultWire = {
  readonly symbol: string;
  readonly opportunities: readonly OmsArbOpportunityWire[];
  readonly refused: readonly ArbRefusal[];
};

function wireOpportunity(opp: ArbOpportunity): OmsArbOpportunityWire {
  return {
    ok: true,
    symbol: opp.symbol,
    buyVenueId: opp.buyVenueId,
    sellVenueId: opp.sellVenueId,
    buyKind: opp.buyKind,
    sellKind: opp.sellKind,
    amount: formatAmount(opp.amount),
    buyAllIn: formatAmount(opp.buyAllIn),
    sellAllIn: formatAmount(opp.sellAllIn),
    edgePerUnit: formatAmount(opp.edgePerUnit),
    buyCostBps: opp.buyCostBps,
    sellCostBps: opp.sellCostBps,
  };
}

function wireScanResult(result: ScanExternalArbResult): OmsArbScanResultWire {
  return {
    symbol: result.symbol,
    opportunities: result.opportunities.map(wireOpportunity),
    refused: result.refused,
  };
}

function parseLedgerAmount(raw: string): { readonly ok: true; readonly value: Amount } | { readonly ok: false } {
  try {
    return { ok: true, value: parseAmount(raw) };
  } catch {
    return { ok: false };
  }
}

function quoteRefusal(venueId: string, detail: string): ArbRefusal {
  return { ok: false, buyVenueId: venueId, sellVenueId: venueId, reason: 'missing_quote', detail };
}

function emptyScan(symbol: string, refused: readonly ArbRefusal[]): OmsArbScanResultWire {
  return { symbol, opportunities: [], refused };
}

export function scanOmsExternalArb(input: OmsArbScanInput): OmsArbScanResultWire {
  const parsedScanAmount = parseLedgerAmount(input.amount);
  if (!parsedScanAmount.ok) {
    return emptyScan(input.symbol, [
      {
        ok: false,
        buyVenueId: '',
        sellVenueId: '',
        reason: 'missing_quote',
        detail: 'scan amount is not a decimal string — amount not invented',
      },
    ]);
  }

  const doorRefused: ArbRefusal[] = [];
  const quotes: ArbVenueQuote[] = [];

  for (const quote of input.quotes) {
    let price: Amount | null = null;
    if (quote.price !== null) {
      const parsedPrice = parseLedgerAmount(quote.price);
      if (!parsedPrice.ok) {
        doorRefused.push(quoteRefusal(quote.venueId, 'quote price is not a decimal string — mid not invented'));
        continue;
      }
      price = parsedPrice.value;
    }

    const parsedAmount = parseLedgerAmount(quote.amount);
    if (!parsedAmount.ok) {
      doorRefused.push(quoteRefusal(quote.venueId, 'quote amount is not a decimal string — amount not invented'));
      continue;
    }

    quotes.push({
      venueId: quote.venueId,
      kind: quote.kind,
      price,
      amount: parsedAmount.value,
      asOfMs: quote.asOfMs,
    });
  }

  if (quotes.length === 0 && doorRefused.length > 0) {
    return emptyScan(input.symbol, doorRefused);
  }

  const result = scanArbClass({
    scanClass: input.scanClass ?? 'cross-exchange',
    fundingRate: input.fundingRate,
    symbol: input.symbol,
    amount: parsedScanAmount.value,
    quotes,
    costTermsByVenue: input.costTermsByVenue,
    inventory: input.inventory,
    nowMs: input.nowMs,
    maxQuoteAgeMs: input.maxQuoteAgeMs,
  });
  const wired = wireScanResult(result);
  return {
    symbol: wired.symbol,
    opportunities: wired.opportunities,
    refused: [...doorRefused, ...wired.refused],
  };
}
