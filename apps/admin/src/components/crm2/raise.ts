/**
 * The Raise screen's figures, from the server's per-currency totals. Each currency is summed on its own by the server in exact
 * decimals. Nothing here converts a currency, and nothing passes an amount through Number.
 *
 * Only committed euros fill the bar against the target. Soft-circled euros show as a ghost extension of the bar and indicated
 * euros as a dotted marker, so a self-reported figure can never look like money in hand.
 */
import type { CrmWorkflowsContract } from '@intafaced/contracts';
import { addDecimal, shareTenths, tenthsText } from './format';
import { RAISE_TARGET_EUR } from './policy';
import { stagesFor } from './format';

type Metrics = Awaited<ReturnType<CrmWorkflowsContract['metrics']>>;
export type MoneyTotal = { currency: string; amount: string };
export type RaiseTotals = Pick<Metrics['raise'], 'indicated' | 'softCircled' | 'committed' | 'counts'>;

const eur = (list: readonly MoneyTotal[]) => list.find((entry) => entry.currency === 'EUR')?.amount ?? '0';

export type RaiseBar = {
  target: string;
  committed: string;
  softCircled: string;
  indicated: string;
  /** Each tier's own share of the target, in tenths of a percent (82 is 8.2%). */
  committedTenths: number;
  softTenths: number;
  indicatedTenths: number;
  /** Where each layer ends along the bar, in tenths of a percent, capped at 100%: committed, then plus soft-circled, then plus indicated. */
  fillEnd: number;
  ghostEnd: number;
  dottedEnd: number;
};

export function raiseBar(raise: Pick<RaiseTotals, 'indicated' | 'softCircled' | 'committed'>, target = RAISE_TARGET_EUR): RaiseBar {
  const committed = eur(raise.committed);
  const softCircled = eur(raise.softCircled);
  const indicated = eur(raise.indicated);
  const cap = (value: number) => Math.min(1000, value);
  const withSoft = addDecimal(committed, softCircled);
  const withIndicated = addDecimal(withSoft, indicated);
  return {
    target,
    committed,
    softCircled,
    indicated,
    committedTenths: shareTenths(committed, target),
    softTenths: shareTenths(softCircled, target),
    indicatedTenths: shareTenths(indicated, target),
    fillEnd: cap(shareTenths(committed, target)),
    ghostEnd: cap(shareTenths(withSoft, target)),
    dottedEnd: cap(shareTenths(withIndicated, target)),
  };
}

export type CurrencyRow = { currency: string; indicated: string; softCircled: string; committed: string };
/** Every currency other than euros, listed on its own. Sorted by code. A tier with nothing in that currency is "0". */
export function otherCurrencies(raise: Pick<RaiseTotals, 'indicated' | 'softCircled' | 'committed'>): CurrencyRow[] {
  const codes = new Set<string>();
  for (const list of [raise.indicated, raise.softCircled, raise.committed])
    for (const entry of list) if (entry.currency !== 'EUR') codes.add(entry.currency);
  const find = (list: readonly MoneyTotal[], code: string) => list.find((entry) => entry.currency === code)?.amount ?? '0';
  return [...codes].sort().map((currency) => ({
    currency,
    indicated: find(raise.indicated, currency),
    softCircled: find(raise.softCircled, currency),
    committed: find(raise.committed, currency),
  }));
}

export const percentText = tenthsText;

export type StageCount = { stage: string; count: number };
/** Investor enquiries per stage, in stage order, with zeros kept so the strip never changes shape. */
export function investorStageCounts(byStage: Metrics['byStage']): StageCount[] {
  return stagesFor('investor').map((stage) => ({
    stage,
    count: byStage.filter((entry) => entry.audience === 'investor' && entry.stage === stage).reduce((sum, entry) => sum + entry.count, 0),
  }));
}

/** Open enquiries of every audience: everything not yet closed. */
export const openEnquiries = (byStage: Metrics['byStage']): number =>
  byStage.filter((entry) => entry.stage !== 'closed').reduce((sum, entry) => sum + entry.count, 0);

export type TierCounts = { label: string; count: number }[];
export function tierCounts(counts: RaiseTotals['counts']): TierCounts {
  return [
    { label: 'Committed', count: counts.committed },
    { label: 'Soft-circled', count: counts.softCircled },
    { label: 'Indicated', count: counts.indicated },
    { label: 'No amount yet', count: counts.undecided },
  ];
}
