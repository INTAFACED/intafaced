import { Button } from '../../shared/ui';
import type { Space } from './client';
import { amount, date, NoRows, ResourceView, Section, useBankRead, type ActionSpec } from './components';
import type { sorterSchema } from './contracts';
import { sorterCopy } from './sorter-copy';
import { bpToPercent, percentToBp, sorterLegs } from './sorter-model';
import type { z } from 'zod';

type Sorter = z.infer<typeof sorterSchema>;
const RUNS_SHOWN = 5;
const fieldName = (spaceId: string) => `share-${spaceId}`;

/**
 * The income sorter on the Spaces page (BK-pots-03, J-bank-07 #4): each payment from another person split across the
 * person's own spaces by percentage, once. The bank's terms, each live sorter with its shares and recent sorts, and a
 * door to set one up per currency. Every amount is the bank's answer; the page only turns typed percents into basis
 * points.
 */
export function IncomeSorter({ spaces, open }: { spaces: Space[]; open: (spec: ActionSpec) => void }) {
  const { t } = sorterCopy.useCopy();
  const read = useBankRead('sorter.list', undefined);
  const named = spaces.filter((space) => space.kind === 'named');
  const nameOf = (spaceId: string) => spaces.find((space) => space.id === spaceId)?.name ?? t('unknownSpace');
  const assets = [...new Set(spaces.map((space) => space.assetId))].sort();

  const setUp = (assetId: string) => {
    const targets = named.filter((space) => space.assetId === assetId);
    const legsOf = (values: Record<string, string>) =>
      sorterLegs(targets.map((space) => ({ spaceId: space.id, text: values[fieldName(space.id)] ?? '' })));
    open({
      title: t('createTitle', { asset: assetId }),
      procedure: 'sorter.create',
      fields: targets.map((space) => ({
        name: fieldName(space.id),
        label: t('field', { space: space.name }),
        unit: '%',
        hint: t('fieldHint'),
        optional: true,
        validate: (value) => (value.trim() === '' || percentToBp(value) !== null ? null : t('fieldInvalid')),
      })),
      notes: [t('createNote'), t('createOne')],
      liveRows: (values) => {
        const { legs, totalBp } = legsOf(values);
        return [
          ...legs.map((leg): [string, string] => [nameOf(leg.spaceId), bpToPercent(leg.shareBp)]),
          ...(totalBp > 0 && totalBp < 10_000 ? [[t('restLabel'), bpToPercent(10_000 - totalBp)] as [string, string]] : []),
        ];
      },
      validate: (input) => {
        const legs = (input.legs as Array<{ shareBp: number }>) ?? [];
        const total = legs.reduce((sum, leg) => sum + leg.shareBp, 0);
        if (!legs.length) return t('empty');
        return total > 10_000 ? t('over', { total: bpToPercent(total).replace('%', '') }) : null;
      },
      input: (values, requestId) => ({ sorterId: requestId, assetId, legs: legsOf(values).legs }),
    });
  };
  const stop = (sorter: Sorter) =>
    open({
      title: t('stopTitle', { asset: sorter.assetId }),
      procedure: 'sorter.cancel',
      facts: sorter.legs.map((leg) => [nameOf(leg.spaceId), bpToPercent(leg.shareBp)]),
      notes: [t('stopNote')],
      input: () => ({ sorterId: sorter.id }),
      submit: t('stop'),
    });

  return (
    <div data-testid="income-sorter">
      <Section title={t('title')} description={t('description')}>
        <ResourceView resource={read.resource} reload={read.reload}>
          {({ terms, sorters }) => {
            const sorted = new Set(sorters.map((sorter) => sorter.assetId));
            return (
              <>
                <p className="money-caption" data-testid="income-sorter-terms" data-state={terms.state}>
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
                <div className="actions">
                  {assets
                    .filter((assetId) => !sorted.has(assetId))
                    .map((assetId) => (
                      <Button
                        key={assetId}
                        variant="secondary"
                        onClick={() => setUp(assetId)}
                        disabled={terms.state === 'not_set' || !named.some((space) => space.assetId === assetId)}
                      >
                        {t('setUp', { asset: assetId })}
                      </Button>
                    ))}
                </div>
                {terms.state === 'set' && !named.length && <p className="money-caption">{t('noSpaces')}</p>}
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
  const runs = useBankRead('sorter.runs', { sorterId: sorter.id, limit: RUNS_SHOWN });
  const total = sorter.legs.reduce((sum, leg) => sum + leg.shareBp, 0);
  const status = (value: 'pending' | 'settled' | 'rejected') => t(value);
  return (
    <article className="money-record" data-testid="income-sorter-card" data-asset={sorter.assetId} data-id={sorter.id}>
      <header>
        <h3>{t('sorts', { asset: sorter.assetId })}</h3>
        <Button variant="ghost" onClick={stop}>
          {t('stop')}
        </Button>
      </header>
      <ul className="money-list">
        {sorter.legs.map((leg) => (
          <li key={leg.spaceId}>{t('leg', { share: bpToPercent(leg.shareBp), space: nameOf(leg.spaceId) })}</li>
        ))}
        {total < 10_000 && <li>{t('rest', { share: bpToPercent(10_000 - total) })}</li>}
      </ul>
      <h4>{t('recent')}</h4>
      <ResourceView resource={runs.resource} reload={runs.reload}>
        {(rows) =>
          rows.length ? (
            rows.map((run) => (
              <div key={run.id} className="money-record" data-testid="income-sorter-run" data-credit={run.creditTxId}>
                <p>{t('run', { amount: amount(run.creditAmount, sorter.assetId), date: date(run.createdAt) })}</p>
                <ul className="money-list">
                  {run.legs.map((leg) => (
                    <li key={leg.position} data-status={leg.status}>
                      {t('runLeg', { amount: amount(leg.amount, sorter.assetId), space: nameOf(leg.spaceId), status: status(leg.status) })}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="money-caption">{t('noRuns')}</p>
          )
        }
      </ResourceView>
    </article>
  );
}
