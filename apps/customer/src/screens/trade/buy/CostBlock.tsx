import { KeyValue, fmtAmount, fmtUsd, type KeyValueItem } from './deps';
import { buyCopy } from './copy';
import type { CostRows } from './cost';
import { formatGet } from './cost-format';

/**
 * The all-in cost, in the card before the Review button (spec R2 item 1). Every row is "—" until it is known: the
 * fee and the limit come from the service's own preview, never from a guess.
 */
export function CostBlock({ rows, side, baseAsset, places }: { rows: CostRows; side: 'buy' | 'sell'; baseAsset: string; places: number }) {
  const { t } = buyCopy.useCopy();
  const buying = side === 'buy';
  const getValue = formatGet(rows.get, baseAsset, places, t);
  const items: KeyValueItem[] = [
    {
      key: 'cost',
      label: buying ? t('Estimated cost') : t('Estimated value'),
      value: rows.estimated === null ? null : t('About {value}', { value: fmtUsd(rows.estimated) }),
    },
    {
      key: 'fee',
      label: t('Fee'),
      value: rows.fee === null ? null : `${fmtAmount(rows.fee.amount, { places: 8 })} ${rows.fee.asset ?? ''}`.trim(),
    },
    { key: 'get', label: t('You get about'), value: getValue },
    { key: 'limit', label: buying ? t('Most you can pay') : t('Least you get'), value: rows.limit === null ? null : fmtUsd(rows.limit) },
  ];
  return (
    <div className="buy-cost" data-testid="cost-block">
      <KeyValue items={items} density="dense" aria-label={t('All-in cost')} unknownLabel={t('Not known yet')} />
    </div>
  );
}
