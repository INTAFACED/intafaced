/**
 * Scaled order form, ladder preview and cost block. A ladder is N ordinary limit orders sent as one batch; there is no
 * parent object. Every number here is exact decimal rounded to the market's price and amount steps, and the same ids are
 * reused if the same ladder is sent again.
 */
import { useMemo, useState } from 'react';
import { Button, Field, Input, KeyValue, SegmentedControl, Switch, Table, fmtAmount, fmtPrice, type TableColumn } from '../rooms/ui';
import { useRoomApi } from '../rooms/read';
import type { BatchOrder } from '../rooms/api';
import type { RoomWriter } from '../rooms/write';
import { execCopy } from './copy';
import type { ExecMarket } from './data';
import {
  MAX_ORDERS,
  MIN_ORDERS,
  buildLadder,
  newNonce,
  scaledId,
  wholeNumber,
  type Distribution,
  type LadderProblem,
  type LadderRow,
  type Side,
} from './model';
import type { BatchItem } from '../rooms/api';
import { ConfirmDialog, Pick, Why, placesFor } from './parts';

export interface ScaledRun {
  nonce: string;
  symbol: string;
  rows: LadderRow[];
  results: BatchItem[] | null;
}

export function ScaledForm({
  markets,
  freeOf,
  writer,
  unconfirmed = false,
  onRun,
}: {
  markets: readonly ExecMarket[];
  freeOf: (asset: string) => string | null;
  writer: RoomWriter;
  /** True while an order of the last ladder is neither confirmed nor ruled out by a status check. */
  unconfirmed?: boolean;
  onRun: (run: ScaledRun | null) => void;
}) {
  const { t } = execCopy.useCopy();
  const room = useRoomApi();
  const [symbol, setSymbol] = useState(markets[0]?.symbol ?? '');
  const [side, setSide] = useState<Side>('buy');
  const [total, setTotal] = useState('');
  const [count, setCount] = useState('5');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [distribution, setDistribution] = useState<Distribution>('equal');
  const [ratio, setRatio] = useState('2');
  const [postOnly, setPostOnly] = useState(false);
  const [nonce, setNonce] = useState(newNonce);
  const [review, setReview] = useState(false);

  const market = markets.find((m) => m.symbol === symbol) ?? null;
  const { ladder, problems } = useMemo(
    () =>
      buildLadder({
        side,
        total,
        count: wholeNumber(count),
        start,
        end,
        distribution,
        ratio: wholeNumber(ratio),
        tick: market?.tickSize ?? null,
        lot: market?.lotSize ?? null,
        minAmount: market?.minAmount ?? null,
        minCost: market?.minCost ?? null,
        taker: market?.taker ?? null,
        maker: market?.maker ?? null,
        freeQuote: market ? freeOf(market.quote) : null,
        freeBase: market ? freeOf(market.base) : null,
      }),
    [side, total, count, start, end, distribution, ratio, market, freeOf],
  );

  const holdAsset = market ? (side === 'buy' ? market.quote : market.base) : '';
  const lotPlaces = placesFor(market?.lotSize);
  const tooSmall = ladder?.rows.some((r) => r.belowMin) ?? false;
  const blocker = !writer.signedIn
    ? t('Sign in to place')
    : unconfirmed
      ? t('Review blocked unconfirmed')
      : !market?.open
        ? t('Market closed block')
        : tooSmall
          ? t('Below minimum block')
          : ladder?.short
            ? t('Not enough free block', { asset: holdAsset })
            : null;
  const canReview = ladder !== null && blocker === null && !writer.busy && writer.note.state === 'none';
  const word = (p: LadderProblem) => t(`Ladder problem ${p}`, { min: String(MIN_ORDERS), max: String(MAX_ORDERS) });
  const first = problems[0];

  async function send() {
    if (!ladder || !market) return;
    const orders: BatchOrder[] = ladder.rows.map((r) => ({
      symbol: market.symbol,
      type: 'limit',
      side,
      amount: r.size,
      price: r.price,
      timeInForce: postOnly ? 'PO' : 'GTC',
      ...(postOnly ? { postOnly: true } : {}),
      clientOrderId: scaledId(nonce, r.index),
    }));
    const run: ScaledRun = { nonce, symbol: market.symbol, rows: ladder.rows, results: null };
    onRun(run);
    const result = await writer.run({ kind: 'place', id: `scl-${nonce}`, symbol: market.symbol, call: () => room.placeBatch(orders) });
    setReview(false);
    if (result.kind === 'done') {
      onRun({ ...run, results: result.data.results });
      setNonce(newNonce());
    } else if (result.kind !== 'uncertain') onRun(null);
  }

  const columns: TableColumn<LadderRow>[] = [
    { id: 'n', header: '#', pin: 'start', value: (r) => String(r.index) },
    { id: 'price', header: t('Price'), numeric: true, value: (r) => r.price, cell: (r) => fmtPrice(r.price, market?.tickSize) },
    { id: 'size', header: t('Size'), numeric: true, value: (r) => r.size, cell: (r) => fmtAmount(r.size, { places: lotPlaces }) },
    { id: 'notional', header: t('Value'), numeric: true, value: (r) => r.notional, cell: (r) => fmtAmount(r.notional, { places: 4 }) },
    {
      id: 'cumSize',
      header: t('Total size'),
      numeric: true,
      value: (r) => r.cumSize,
      cell: (r) => fmtAmount(r.cumSize, { places: lotPlaces }),
    },
    { id: 'cumHold', header: t('Total held'), numeric: true, value: (r) => r.cumHold, cell: (r) => fmtAmount(r.cumHold, { places: 4 }) },
    { id: 'flag', header: t('Check'), cell: (r) => (r.belowMin ? t('Below minimum') : t('OK')) },
  ];

  const summary = ladder
    ? [
        { label: t('Orders'), value: String(ladder.rows.length) },
        { label: t('Total size'), value: `${fmtAmount(ladder.totalSize, { places: lotPlaces })} ${market?.base ?? ''}` },
        { label: t('Average price'), value: ladder.avgPrice === null ? null : fmtPrice(ladder.avgPrice, market?.tickSize) },
        { label: t('Total held'), value: `${fmtAmount(ladder.hold, { places: 6 })} ${holdAsset}`, hint: t('Held when the orders rest') },
        {
          label: t('Fee if resting'),
          value: ladder.feeMaker === null ? null : `${fmtAmount(ladder.feeMaker, { places: 6 })} ${market?.quote ?? ''}`,
          hint: t('Estimate at the maker rate'),
        },
        {
          label: t('Fee if matched at once'),
          value: ladder.feeTaker === null ? null : `${fmtAmount(ladder.feeTaker, { places: 6 })} ${market?.quote ?? ''}`,
          hint: t('Estimate at the taker rate'),
        },
        { label: t('Free after'), value: ladder.freeAfter === null ? null : `${fmtAmount(ladder.freeAfter, { places: 6 })} ${holdAsset}` },
      ]
    : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section aria-label={t('New ladder')} className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
        <h3 className="m-0 text-md font-medium text-fg">{t('New ladder')}</h3>
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
          error={first === 'total' && total ? word('total') : first === 'lot' ? word('lot') : undefined}
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
          label={t('Number of orders')}
          hint={t('{min} to {max}', { min: String(MIN_ORDERS), max: String(MAX_ORDERS) })}
          error={problems.includes('count') ? word('count') : undefined}
        >
          <Input aria-label={t('Number of orders')} value={count} onValueChange={(v) => setCount(v.replace(/\D/g, ''))} density="dense" />
        </Field>
        <Field label={t('First price')} error={problems.includes('range') ? word('range') : undefined}>
          <Input
            kind="decimal"
            aria-label={t('First price')}
            value={start}
            onValueChange={setStart}
            precision={placesFor(market?.tickSize)}
            density="dense"
          />
        </Field>
        <Field label={t('Last price')}>
          <Input
            kind="decimal"
            aria-label={t('Last price')}
            value={end}
            onValueChange={setEnd}
            precision={placesFor(market?.tickSize)}
            density="dense"
          />
        </Field>
        <Field label={t('Size distribution')}>
          <Pick
            label={t('Size distribution')}
            value={distribution}
            options={[
              { value: 'equal', label: t('Equal') },
              { value: 'ascending', label: t('Ascending') },
              { value: 'descending', label: t('Descending') },
              { value: 'ratio', label: t('By ratio') },
            ]}
            onChange={setDistribution}
          />
        </Field>
        {distribution === 'ratio' ? (
          <Field
            label={t('Last size to first size')}
            hint={t('A whole number, 1 to 100')}
            error={problems.includes('ratio') ? word('ratio') : undefined}
          >
            <Input
              aria-label={t('Last size to first size')}
              value={ratio}
              onValueChange={(v) => setRatio(v.replace(/\D/g, ''))}
              density="dense"
            />
          </Field>
        ) : null}
        <Field label={t('Time in force')} hint={t('Good till cancelled')}>
          <Input aria-label={t('Time in force')} value="GTC" readOnly density="dense" />
        </Field>
        <Field label={t('Post only')} orientation="horizontal" hint={t('Post only hint')}>
          <Switch aria-label={t('Post only')} checked={postOnly} onCheckedChange={setPostOnly} />
        </Field>
        {market ? (
          <p className="m-0 text-sm text-fg-2">
            {t('Free {asset} {amount}', { asset: holdAsset, amount: fmtAmount(freeOf(holdAsset), { places: 6 }) })}
          </p>
        ) : null}
        {first === 'samePrices' || first === 'tooSmall' ? <Why>{word(first)}</Why> : null}
        {blocker ? <Why>{blocker}</Why> : null}
        <Button size={40} fullWidth disabled={!canReview} onClick={() => setReview(true)}>
          {t('Review ladder')}
        </Button>
        {writer.note.state !== 'none' ? <Why>{t('Locked by unconfirmed request')}</Why> : null}
      </section>
      <section aria-label={t('Ladder preview')} className="flex min-w-0 flex-col gap-3">
        <p className="m-0 text-sm text-fg-2">
          {t('Rounding note', { tick: market?.tickSize ?? '—', lot: market?.lotSize ?? '—' })}
          {ladder && ladder.residual !== '0'
            ? ` ${t('Residual note', { residual: ladder.residual ?? '—', n: String(ladder.rows.length) })}`
            : ''}
        </p>
        <Table
          label={t('Ladder preview')}
          density="dense"
          columns={columns}
          rows={ladder?.rows ?? []}
          minWidth={720}
          getRowId={(r) => String(r.index)}
          emptyState={<p className="m-0 p-3 text-sm text-fg-2">{t('Fill the form to see the ladder')}</p>}
        />
        {ladder ? <KeyValue density="dense" aria-label={t('Cost')} items={summary} /> : null}
      </section>
      <ConfirmDialog
        open={review}
        title={t('Place these orders?')}
        description={t('Confirm ladder body', { n: String(ladder?.rows.length ?? 0) })}
        rows={[
          { label: t('Market'), value: symbol },
          { label: t('Side'), value: side === 'buy' ? t('Buy') : t('Sell') },
          ...summary,
          { label: t('Request ids'), value: `scl-${nonce}-1 …`, mono: true },
        ]}
        confirmLabel={t('Place orders')}
        busy={writer.busy}
        onConfirm={() => void send()}
        onCancel={() => setReview(false)}
      />
    </div>
  );
}
