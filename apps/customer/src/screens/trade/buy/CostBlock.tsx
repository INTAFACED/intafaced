import { KeyValue, type KeyValueRow } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtUsd } from './deps';
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
  // A figure not known yet shows "—" (read out as "Not known") and is marked unset, never 0.
  const row = (label: string, value: string | null): KeyValueRow =>
    value === null
      ? {
          label,
          value: (
            <>
              <span aria-hidden="true">—</span>
              <span className="lt-sr">{t('Not known')}</span>
            </>
          ),
          unset: true,
        }
      : { label, value };
  const items: KeyValueRow[] = [
    row(
      buying ? t('Estimated cost') : t('Estimated value'),
      rows.estimated === null ? null : t('About {value}', { value: fmtUsd(rows.estimated) }),
    ),
    row(t('Fee'), rows.fee === null ? null : `${fmtAmount(rows.fee.amount, { places: 8 })} ${rows.fee.asset ?? ''}`.trim()),
    row(t('You get about'), getValue),
    row(buying ? t('Most you can pay') : t('Least you get'), rows.limit === null ? null : fmtUsd(rows.limit)),
  ];
  return (
    <div data-testid="cost-block">
      <KeyValue rows={items} label={t('All-in cost')} />
    </div>
  );
}
