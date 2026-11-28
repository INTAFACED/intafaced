import { KeyValue } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtUsd } from '../../../data';
import { buyCopy } from './copy';
import type { CostRows } from './cost';
import { formatGet } from './cost-format';

/**
 * The all-in cost, in the card before the Review button (spec R2 item 1). Every row is "Not known" until it is known: the
 * fee and the limit come from the service's own preview, never from a guess.
 */
export function CostBlock({ rows, side, baseAsset, places }: { rows: CostRows; side: 'buy' | 'sell'; baseAsset: string; places: number }) {
  const { t } = buyCopy.useCopy();
  const buying = side === 'buy';
  const getValue = formatGet(rows.get, baseAsset, places, t);
  const items: { label: string; value: string | null }[] = [
    {
      label: buying ? t('Estimated cost') : t('Estimated value'),
      value: rows.estimated === null ? null : t('About {value}', { value: fmtUsd(rows.estimated) }),
    },
    {
      label: t('Fee'),
      value:
        rows.fee === null
          ? null
          : [
              `${fmtAmount(rows.fee.amount, { places: 8 })} ${rows.fee.asset ?? ''}`.trim(),
              rows.fee.usd === null ? null : t('Fee in dollars', { value: fmtUsd(rows.fee.usd) }),
            ]
              .filter(Boolean)
              .join(' '),
    },
    { label: t('You get about'), value: getValue },
    { label: buying ? t('Most you can pay') : t('Least you get'), value: rows.limit === null ? null : fmtUsd(rows.limit) },
  ];
  return (
    <div data-testid="cost-block">
      <KeyValue
        label={t('All-in cost')}
        rows={items.map((item) => ({ label: item.label, value: item.value ?? t('Not known'), unset: item.value === null }))}
      />
    </div>
  );
}
