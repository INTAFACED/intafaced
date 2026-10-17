/**
 * Iceberg: fully usable up to the review so the numbers can be checked, and then blocked by name. The order API has no
 * display size, so this tab never sends a plain order dressed up as an iceberg.
 */
import { useMemo, useState } from 'react';
import { Button, Field, Input, KeyValue, SegmentedControl, fmtAmount, fmtPrice } from '../rooms/ui';
import { useOpenOrders, useRefreshPrivate } from '../desk/data';
import { execCopy } from './copy';
import type { ExecMarket } from './data';
import { buildBlotter } from './blotter';
import { reviewIceberg, type IcebergProblem, type Side } from './model';
import { BlotterTable, useCancelFlow } from './OrdersView';
import { Gate, Pick, Why, placesFor } from './parts';

export function IcebergTab({ markets }: { markets: readonly ExecMarket[] }) {
  const { t } = execCopy.useCopy();
  const [symbol, setSymbol] = useState(markets[0]?.symbol ?? '');
  const [side, setSide] = useState<Side>('buy');
  const [total, setTotal] = useState('');
  const [display, setDisplay] = useState('');
  const [price, setPrice] = useState('');
  const open = useOpenOrders();
  const refresh = useRefreshPrivate();
  const cancel = useCancelFlow(refresh);
  const market = markets.find((m) => m.symbol === symbol) ?? null;
  const review = reviewIceberg({ total, display, price, lot: market?.lotSize ?? null, tick: market?.tickSize ?? null });
  const lotPlaces = placesFor(market?.lotSize);
  const rows = useMemo(() => buildBlotter(open.status === 'ready' ? open.data : [], [], [], []), [open]);
  const word = (p: IcebergProblem) => t(`Iceberg problem ${p}`);
  const holdAsset = side === 'buy' ? market?.quote : market?.base;

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section aria-label={t('New iceberg')} className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
        <h3 className="m-0 text-md font-medium text-fg">{t('New iceberg')}</h3>
        <Field label={t('Market')}>
          <Pick
            label={t('Market')}
            value={symbol}
            options={markets.map((m) => ({ value: m.symbol, label: m.symbol }))}
            onChange={setSymbol}
          />
        </Field>
        <SegmentedControl
          aria-label={t('Side')}
          size={32}
          fullWidth
          value={side}
          onValueChange={(v) => setSide(v as Side)}
          items={[
            { value: 'buy', label: t('Buy'), tone: 'up' },
            { value: 'sell', label: t('Sell'), tone: 'down' },
          ]}
        />
        <Field
          label={t('Total size ({asset})', { asset: market?.base ?? '' })}
          error={review.problems.includes('total') && total ? word('total') : review.problems.includes('lot') ? word('lot') : undefined}
        >
          <Input
            kind="decimal"
            aria-label={t('Total size ({asset})', { asset: market?.base ?? '' })}
            value={total}
            onValueChange={setTotal}
            precision={lotPlaces}
            density="dense"
          />
        </Field>
        <Field
          label={t('Display size ({asset})', { asset: market?.base ?? '' })}
          hint={
            review.referenceMin
              ? t('Venue reference minimum {min}', { min: fmtAmount(review.referenceMin, { places: lotPlaces }) })
              : t('Venue reference hint')
          }
          error={
            review.problems.includes('displayTooBig')
              ? word('displayTooBig')
              : review.problems.includes('display') && display
                ? word('display')
                : undefined
          }
        >
          <Input
            kind="decimal"
            aria-label={t('Display size ({asset})', { asset: market?.base ?? '' })}
            value={display}
            onValueChange={setDisplay}
            precision={lotPlaces}
            density="dense"
          />
        </Field>
        <Field label={t('Limit price')} error={review.problems.includes('price') && price ? word('price') : undefined}>
          <Input
            kind="decimal"
            aria-label={t('Limit price')}
            value={price}
            onValueChange={setPrice}
            precision={placesFor(market?.tickSize)}
            density="dense"
          />
        </Field>
        <Field label={t('Time in force')} hint={t('Good till cancelled')}>
          <Input aria-label={t('Time in force')} value="GTC" readOnly density="dense" />
        </Field>
        <KeyValue
          density="dense"
          aria-label={t('Iceberg review')}
          items={[
            {
              label: t('Shown at a time'),
              value: review.visible === null ? null : `${fmtAmount(review.visible, { places: lotPlaces })} ${market?.base ?? ''}`,
            },
            {
              label: t('Hidden'),
              value: review.hidden === null ? null : `${fmtAmount(review.hidden, { places: lotPlaces })} ${market?.base ?? ''}`,
            },
            { label: t('Refills'), value: review.refills },
            {
              label: t('Held'),
              value:
                review.hold === null
                  ? null
                  : side === 'buy'
                    ? `${fmtAmount(review.hold, { places: 4 })} ${market?.quote ?? ''}`
                    : `${fmtAmount(total, { places: lotPlaces })} ${market?.base ?? ''}`,
              hint: holdAsset ? t('Limit price times total, held in {asset}', { asset: holdAsset }) : undefined,
            },
            { label: t('Limit price'), value: review.problems.includes('price') ? null : fmtPrice(price, market?.tickSize) },
          ]}
        />
        <Button size={40} fullWidth disabled>
          {t('Place iceberg')}
        </Button>
        <Why>{t('Iceberg blocker')}</Why>
      </section>
      <section aria-label={t('Open orders')} className="flex min-w-0 flex-col gap-2">
        <h3 className="m-0 text-md font-medium text-fg">{t('Your open orders')}</h3>
        <Gate load={open}>
          {() => (
            <BlotterTable
              rows={rows}
              label={t('Open orders')}
              emptyText={t('No open orders')}
              onCancel={cancel.ask}
              cancelLocked={cancel.locked}
            />
          )}
        </Gate>
        {cancel.notice}
        {cancel.dialog}
      </section>
    </div>
  );
}
