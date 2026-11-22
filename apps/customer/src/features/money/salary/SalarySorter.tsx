import { Button } from '@intafaced/ui/lit';

import type { Space } from '../client';

import { amount, date, type ActionSpec } from '../components';

import { useIncomeSorter, useSorterRuns } from '../IncomeSorter';

import type { sorterListSchema } from '../contracts';

import { sorterCopy } from '../sorter-copy';

import { bpToPercent } from '../sorter-model';

import { Loaded as ResourceView, NoRows, Part as Section } from './SalaryParts';

import type { z } from 'zod';

type Sorter = z.infer<typeof sorterListSchema>['sorters'][number];

/**
 * The salary room's drawing of `IncomeSorter` (../IncomeSorter.tsx, which Spaces still draws): the same calls through
 * `open(spec)`, words and ids, in the Volt kit.
 *
 * The income sorter on the Spaces page (BK-pots-03, J-bank-07 #4): each payment from another person split across the
 * person's own spaces by percentage, once. The bank's terms, each live sorter with its shares and recent sorts, and a
 * door to set one up per currency. Every amount is the bank's answer; the page only turns typed percents into basis
 * points.
 */
export function SalarySorter({ spaces, open }: { spaces: Space[]; open: (spec: ActionSpec) => void }) {
  const { t, read, named, nameOf, assets, setUp, stop } = useIncomeSorter(spaces, open);
  return (
    <div data-testid="income-sorter">
      <Section title={t('title')} description={t('description')}>
        <ResourceView resource={read.resource} reload={read.reload}>
          {({ terms, sorters }) => {
            const sorted = new Set(sorters.map((sorter) => sorter.assetId));
            return (
              <>
                <p data-testid="income-sorter-terms" data-state={terms.state}>
                  {terms.state === 'not_set'
                    ? t('termsUnset')
                    : /^0(\.0+)?$/.test(terms.minCredit)
                      ? t('termsAll')
                      : t('termsSet', { min: terms.minCredit })}
                </p>
                {sorters.length ? (
                  sorters.map((sorter) => <SorterCard key={sorter.id} sorter={sorter} nameOf={nameOf} stop={() => stop(sorter)} />)
                ) : (
                  <NoRows title={t('none')} />
                )}
                <div className="lt-actions">
                  {assets
                    .filter((assetId) => !sorted.has(assetId))
                    .map((assetId) => (
                      <Button
                        key={assetId}
                        tone="secondary"
                        onClick={() => setUp(assetId)}
                        disabled={terms.state === 'not_set' || !named.some((space) => space.assetId === assetId)}
                      >
                        {t('setUp', { asset: assetId })}
                      </Button>
                    ))}
                </div>
                {terms.state === 'set' && !named.length && <p>{t('noSpaces')}</p>}
              </>
            );
          }}
        </ResourceView>
      </Section>
    </div>
  );
}

function SorterCard({ sorter, nameOf, stop }: { sorter: Sorter; nameOf: (spaceId: string) => string; stop: () => void }) {
  const { t } = sorterCopy.useCopy();
  const runs = useSorterRuns(sorter.id);
  // A share into a space archived since stays in the account, so it counts toward what stays.
  const total = sorter.legs.filter((leg) => !leg.archived).reduce((sum, leg) => sum + leg.shareBp, 0);
  // The bank names every target, archived ones too; the page's own list of spaces holds only live ones.
  const spaceName = (spaceId: string) => sorter.legs.find((leg) => leg.spaceId === spaceId)?.spaceName || nameOf(spaceId);
  const status = (value: 'pending' | 'settled' | 'rejected') => t(value);
  return (
    <article data-testid="income-sorter-card" data-asset={sorter.assetId} data-id={sorter.id}>
      <header>
        <h3>{t('sorts', { asset: sorter.assetId })}</h3>
        <Button tone="quiet" onClick={stop}>
          {t('stop')}
        </Button>
      </header>
      <ul>
        {sorter.legs.map((leg) => (
          <li key={leg.spaceId} data-archived={leg.archived || undefined}>
            {t('leg', { share: bpToPercent(leg.shareBp), space: spaceName(leg.spaceId) })}
            {leg.archived && <span className="lt-hint"> {t('archived', { space: spaceName(leg.spaceId) })}</span>}
          </li>
        ))}
        {total < 10_000 && <li>{t('rest', { share: bpToPercent(10_000 - total) })}</li>}
      </ul>
      <h4>{t('recent')}</h4>
      <ResourceView resource={runs.resource} reload={runs.reload}>
        {(rows) =>
          rows.length ? (
            rows.map((run) => (
              <div key={run.id} data-testid="income-sorter-run" data-credit={run.creditTxId}>
                <p>{t('run', { amount: amount(run.creditAmount, sorter.assetId), date: date(run.creditPostedAt) })}</p>
                {run.skippedReason && (
                  <p data-skipped={run.skippedReason}>{t(run.skippedReason === 'below_minimum' ? 'skippedSmall' : 'skippedTerms')}</p>
                )}
                <ul>
                  {run.legs.map((leg) => (
                    <li key={leg.position} data-status={leg.status}>
                      {t('runLeg', {
                        amount: amount(leg.amount, sorter.assetId),
                        space: spaceName(leg.spaceId),
                        status: status(leg.status),
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p>{t('noRuns')}</p>
          )
        }
      </ResourceView>
    </article>
  );
}
