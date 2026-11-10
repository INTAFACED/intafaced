import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { heldFigure, type FigureState } from '@intafaced/venue-contracts';
import { BankError } from '../errors.js';
import type { CardPartnerTerms } from './partner-terms.js';

/**
 * PROGRAMME FUNDING (J-bank-26 #6; BK-cops-05), as an operator reads it: the settlement reconciliation against the card
 * partner's own figures, the stablecoin conversion, and which of fund, defund and auto reload the partner offers.
 *
 * The money is the partner's (OWNER 226): the programme's funding sits with it, under its licence. So nothing here posts
 * to the ledger and nothing here is a balance of ours. The reconciliation sets the app's own records (open authorisation
 * holds and settled captures, per funding asset, from `bank.card_authorizations` and `bank.card_settlements`) beside the
 * figures the partner reports. A figure the partner has not reported is "not known", and so is the difference: an
 * unreported figure is never read as 0, and a difference against an unknown is never "matches" (CUSTODY-DELTA §1.3).
 */

export interface AppProgrammeFigure {
  readonly held: Amount;
  readonly captured: Amount;
}

/**
 * `missing`: the app holds no record for an asset the partner reports with a known figure, a break by name, never read
 * as 0 (OWNER 288). `not_known`: the partner's side is not known (not reported, or sent with no time).
 */
export type ReconciliationStatus = 'matches' | 'break' | 'missing' | 'not_known';

export interface ReconciliationRow {
  readonly assetId: string;
  /** The app's records: open holds, settled captures, and the two together. Null when the app has no record ("missing"). */
  readonly appHeld: string | null;
  readonly appCaptured: string | null;
  readonly appFigure: string | null;
  /** The partner's held plus captured for this asset, or null ("not known": not reported, or sent with no time). */
  readonly partnerFigure: string | null;
  /** The partner's own time for its figure, or null when it sent none (b2 change 6). */
  readonly partnerAsOf: string | null;
  /** The partner's figure as displayed: known, stale (older than the partner's limit), or unknown. */
  readonly partnerState: FigureState;
  /** Partner minus app, signed; null when either side has no figure. */
  readonly difference: string | null;
  readonly status: ReconciliationStatus;
  /**
   * The stablecoin conversion: one unit of this asset in the programme's funding asset, from the rate source with the time
   * it stamped, and the app's figure converted at that rate (rounded up: the programme funds at least what it owes). Each
   * null when the funding asset or the rate is not known.
   */
  readonly fundingRate: string | null;
  readonly fundingRateAsOf: string | null;
  readonly appFigureInFunding: string | null;
}

/** Every asset either side has a figure for, in a stable order; each row reconciled. */
export function reconcileProgramme(
  app: ReadonlyMap<string, AppProgrammeFigure>,
  partner: CardPartnerTerms['programmeFigures'],
  marks: ReadonlyMap<string, { readonly price: Amount; readonly asOf: Date }>,
  /** The partner's own time for its figures and its declared limit (b2 change 6); `asOf` null is "not known". */
  reported: { readonly asOf: Date | null; readonly staleAfterMs: number; readonly source: string; readonly now: Date },
): ReconciliationRow[] {
  const assets = [...new Set([...app.keys(), ...Object.keys(partner ?? {})])].sort();
  return assets.map((assetId) => {
    // The app holds no record for an asset the partner reports: our side is missing, a break by name, never 0 (OWNER 288).
    const mine = app.get(assetId) ?? null;
    const appFigure = mine === null ? null : mine.held + mine.captured;
    const theirs = partner?.[assetId];
    // A partner that reports figures but none for this asset has not reported it: "not known", not 0. A figure it sent
    // with no time is "not known" too: we cannot say how old it is, so it never "matches".
    const sum = theirs ? parseAmount(theirs.held) + parseAmount(theirs.captured) : null;
    const figure = heldFigure({
      source: reported.source,
      amount: sum === null ? null : formatAmount(sum),
      asOf: reported.asOf,
      staleAfterMs: reported.staleAfterMs,
      now: reported.now,
    });
    const partnerFigure = figure.state === 'unknown' ? null : sum;
    const difference = partnerFigure === null || appFigure === null ? null : partnerFigure - appFigure;
    const mark = marks.get(assetId);
    return {
      assetId,
      appHeld: mine === null ? null : formatAmount(mine.held),
      appCaptured: mine === null ? null : formatAmount(mine.captured),
      appFigure: appFigure === null ? null : formatAmount(appFigure),
      partnerFigure: partnerFigure === null ? null : formatAmount(partnerFigure),
      partnerAsOf: figure.asOf ? figure.asOf.toISOString() : null,
      partnerState: figure.state,
      difference: difference === null ? null : formatAmount(difference),
      // A partner side we cannot read is "not known" first: with it unknown, no side can be called missing. Against a
      // known partner figure, no record of ours is "missing".
      status: partnerFigure === null ? 'not_known' : appFigure === null ? 'missing' : difference === 0n ? 'matches' : 'break',
      fundingRate: mark ? formatAmount(mark.price) : null,
      fundingRateAsOf: mark ? mark.asOf.toISOString() : null,
      appFigureInFunding: mark && appFigure !== null ? formatAmount(mul(appFigure, mark.price, 'ceil')) : null,
    };
  });
}

export const FUNDING_KINDS = ['fund', 'defund', 'auto_reload'] as const;
export type FundingKind = (typeof FUNDING_KINDS)[number];

export type FundingOfferState = 'offered' | 'not_offered' | 'not_known';

/** Fund, defund and auto reload, each offered, "not offered by the partner", or "not known" when the partner is silent. */
export function fundingOfferStates(terms: CardPartnerTerms): Record<FundingKind, FundingOfferState> {
  const o = terms.fundingOffers;
  const state = (offered: boolean | undefined): FundingOfferState => (o === null ? 'not_known' : offered ? 'offered' : 'not_offered');
  return { fund: state(o?.fund), defund: state(o?.defund), auto_reload: state(o?.autoReload) };
}

/**
 * A funding request may go to the partner only where the partner offers that kind and has said which stablecoin the
 * programme funds in. Anything else refuses by name, before any approval is used or anything is written.
 */
export function assertFundingOffered(terms: CardPartnerTerms, kind: FundingKind): string {
  const state = fundingOfferStates(terms)[kind];
  if (state !== 'offered') {
    throw new BankError(
      state === 'not_known'
        ? `The card partner has not said whether it offers ${kind.replace('_', ' ')} (bank.card_funding_not_offered)`
        : `The card partner does not offer ${kind.replace('_', ' ')} for this programme (bank.card_funding_not_offered)`,
      'bank.card_funding_not_offered',
    );
  }
  if (!terms.fundingAssetId) {
    throw new BankError(
      'The card partner has not said which stablecoin the programme is funded in (bank.card_funding_not_offered)',
      'bank.card_funding_not_offered',
    );
  }
  return terms.fundingAssetId;
}
