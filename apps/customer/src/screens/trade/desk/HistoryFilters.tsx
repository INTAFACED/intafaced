import { deskCopy } from './copy';
import { Button } from '@intafaced/ui/lit';
import { Select } from '@intafaced/ui/lit/templates';
import { isFiltering, NO_HISTORY_FILTER, type HistoryFilter } from './history-filter';

type Key = keyof HistoryFilter;

const OPTIONS: { readonly key: Key; readonly values: readonly string[] }[] = [
  { key: 'side', values: ['all', 'buy', 'sell'] },
  { key: 'type', values: ['all', 'market', 'limit', 'stop_limit', 'stop'] },
  { key: 'status', values: ['all', 'closed', 'canceled', 'rejected', 'expired'] },
];

/** Side, type and status picks over the loaded Order history rows. Every pick starts at All. */
export function HistoryFilters({ filter, onFilter }: { filter: HistoryFilter; onFilter: (next: HistoryFilter) => void }) {
  const { t } = deskCopy.useCopy();
  const word = (key: Key, value: string): string => {
    if (value === 'all') return t('History filter all');
    if (key === 'side') return value === 'buy' ? t('Buy') : t('Sell');
    if (key === 'type')
      return value === 'market'
        ? t('History filter type market')
        : value === 'limit'
          ? t('History filter type limit')
          : value === 'stop'
            ? t('History filter type stop')
            : t('History filter type stop_limit');
    return value === 'closed'
      ? t('History filter status closed')
      : value === 'canceled'
        ? t('History filter status canceled')
        : value === 'rejected'
          ? t('History filter status rejected')
          : t('History filter status expired');
  };
  const heading = { side: t('History filter side'), type: t('History filter type'), status: t('History filter status') } as const;
  return (
    <div className="lt-row" role="group" aria-label={t('Order history')}>
      {OPTIONS.map(({ key, values }) => {
        const id = `dk-hfilter-${key}`;
        return (
          <div className="lt-stack-tight lt-tight" key={key}>
            <span className="lt-label" id={id}>
              {heading[key]}
            </span>
            <Select
              size="sm"
              labelledBy={id}
              value={filter[key]}
              onChange={(next) => (next !== filter[key] ? onFilter({ ...filter, [key]: next } as HistoryFilter) : undefined)}
              options={values.map((value) => ({ value, label: word(key, value) }))}
            />
          </div>
        );
      })}
      {isFiltering(filter) ? (
        <Button tone="quiet" size="sm" onClick={() => onFilter(NO_HISTORY_FILTER)}>
          {t('History filter clear')}
        </Button>
      ) : null}
    </div>
  );
}
