/**
 * Iceberg: a limit order that shows only its display size on the house book and refills from the hidden rest. The order goes
 * through the room writer with a confirm and one request id per intent; an unknown outcome is settled by reading the order
 * back by that id, never by sending again. Sending to a live venue is shown and switched off while no venue submit port is set.
 */
import { useMemo, useState } from 'react';
import { Button, Field, Input, KeyValue, SegmentedControl, fmtAmount, fmtPrice } from '../rooms/ui';
import { WriteNotice } from '../rooms/RoomNotices';
import { useRoomApi } from '../rooms/read';
import { useRoomWriter } from '../rooms/write';
import { useOpenOrders, useRefreshPrivate } from '../desk/data';
import { execCopy } from './copy';
import { useTradeApi, type ExecMarket } from './data';
import { buildBlotter } from './blotter';
import { icebergClientId, newNonce, ownsNote, reviewIceberg, type IcebergProblem, type Side } from './model';
import { BlotterTable, useCancelFlow } from './OrdersView';
import { ConfirmDialog, Gate, Pick, Why, placesFor } from './parts';

export function IcebergTab({ markets }: { markets: readonly ExecMarket[] }) {
  const { t } = execCopy.useCopy();
  const [symbol, setSymbol] = useState(markets[0]?.symbol ?? '');
  const [side, setSide] = useState<Side>('buy');
  const [total, setTotal] = useState('');
  const [display, setDisplay] = useState('');
  const [price, setPrice] = useState('');
  const [nonce, setNonce] = useState(newNonce);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const room = useRoomApi();
  const trade = useTradeApi();
  const writer = useRoomWriter();
  const open = useOpenOrders();
  const refresh = useRefreshPrivate();
  const cancel = useCancelFlow(refresh);
  const market = markets.find((m) => m.symbol === symbol) ?? null;
  const review = reviewIceberg({ total, display, price, lot: market?.lotSize ?? null, tick: market?.tickSize ?? null });
  const lotPlaces = placesFor(market?.lotSize);
  const rows = useMemo(() => buildBlotter(open.status === 'ready' ? open.data : [], [], [], []), [open]);
  const word = (p: IcebergProblem) => t(`Iceberg problem ${p}`);
  const holdAsset = side === 'buy' ? market?.quote : market?.base;
  const clientOrderId = icebergClientId(nonce);
  const canReview = market !== null && review.problems.length === 0 && writer.signedIn;

  async function send() {
    if (!market || review.problems.length > 0) return;
    setNote(null);
    const result = await writer.run({
      kind: 'place',
      id: clientOrderId,
      symbol: market.symbol,
      call: () =>
        room.placeIceberg({
          symbol: market.symbol,
          side,
          amount: total.trim(),
          price: price.trim(),
          displayQty: display.trim(),
          clientOrderId,
        }),
    });
    setConfirming(false);
    if (result.kind === 'done' || result.kind === 'refused') setNonce(newNonce());
    if (result.kind === 'done') refresh();
  }

  /** The note holds `ice-<nonce>` and the market, so a check works after a reload. A note from another screen is never released here. */
  async function checkPending(id: string) {
    if (writer.note.state === 'pending' && !ownsNote('iceberg', writer.note.pending)) {
      setNote(t('Check in another room'));
      return;
    }
    const symbol = writer.note.state === 'pending' ? writer.note.pending.symbol : (market?.symbol ?? '');
    if (!symbol) return;
    const [openRead, closedRead] = await Promise.all([trade.orders('open', symbol, 500), trade.orders('closed', symbol, 500)]);
    if (!openRead.ok || !closedRead.ok) {
      setNote(t('Could not check, try again'));
      return;
    }
    const found = [...openRead.data, ...closedRead.data].find((o) => o.clientOrderId === id);
    writer.resolve(id);
    setNonce(newNonce());
    setNote(found ? t('Iceberg check found {status}', { status: found.status }) : t('Iceberg check none'));
    refresh();
  }

  const confirmRows = [
    { label: t('Market'), value: symbol },
    { label: t('Side'), value: side === 'buy' ? t('Buy') : t('Sell') },
    { label: t('Total size ({asset})', { asset: market?.base ?? '' }), value: fmtAmount(total, { places: lotPlaces }) },
    { label: t('Display size ({asset})', { asset: market?.base ?? '' }), value: fmtAmount(display, { places: lotPlaces }) },
    { label: t('Limit price'), value: fmtPrice(price, market?.tickSize) },
    { label: t('Where it rests'), value: t('House order book') },
    { label: t('Request id'), value: clientOrderId },
  ];

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
        <Field label={t('Where it rests')}>
          <Input aria-label={t('Where it rests')} value={t('House order book')} readOnly density="dense" />
        </Field>
        <Field label={t('Request id')} hint={t('Made once for this request, so a re-send cannot place a second order')}>
          <Input aria-label={t('Request id')} value={clientOrderId} readOnly density="dense" />
        </Field>
        {!writer.signedIn ? <Why>{t('Sign in to place')}</Why> : null}
        <Button
          size={40}
          fullWidth
          disabled={!canReview || writer.busy || writer.note.state !== 'none'}
          onClick={() => setConfirming(true)}
        >
          {t('Review iceberg')}
        </Button>
        <WriteNotice writer={writer} onCheck={(id) => void checkPending(id)} done={t('Iceberg placed')} />
        {note ? (
          <p role="status" className="m-0 text-sm text-warn">
            {note}
          </p>
        ) : null}
        <Button variant="secondary" size={32} fullWidth disabled>
          {t('Live venue')}
        </Button>
        <Why>{t('Iceberg live door off')}</Why>
        <ConfirmDialog
          open={confirming}
          title={t('Place this iceberg?')}
          description={t('Confirm iceberg body')}
          rows={confirmRows}
          confirmLabel={t('Place iceberg')}
          busy={writer.busy}
          onConfirm={() => void send()}
          onCancel={() => setConfirming(false)}
        />
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
