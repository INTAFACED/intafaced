import { useEffect, useMemo, useRef, useState } from 'react';
import { fractionDigits } from '../../../data/decimal';
import type { DeskStatus, OtcMakers } from '../rooms/api';
import { Refusal } from '../rooms/RoomNotices';
import { roomWords } from '../rooms/refusals';
import type { RoomApi } from '../rooms/api';
import type { RoomWriter } from '../rooms/write';
import {
  Button,
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  type Loadable,
} from '../rooms/ui';
import type { PairOption } from './data';
import { compareDecimals } from '../rooms/math';
import { noteSymbol, requestBlock, type DeskState, type RequestBlock, type Side } from './model';
import type { RfqQuote } from '../rooms/api';
import { otcCopy } from './copy';

const BLOCK_KEY = {
  'signed-out': 'Block signed out',
  'desk-loading': 'Block desk loading',
  'desk-unreadable': 'Block desk unreadable',
  'desk-closed': 'Block desk closed',
  'no-pair': 'Block no pair',
  'bad-size': 'Block bad size',
  'off-lot': 'Block off lot',
  locked: 'Block locked',
  busy: 'Block busy',
} as const satisfies Record<RequestBlock, string>;

function deskState(desk: Loadable<DeskStatus>): DeskState {
  if (desk.status === 'loading') return 'loading';
  if (desk.status === 'ready') return desk.data.published ? 'open' : 'closed';
  return 'unreadable';
}

const newNonce = () => `otc-req-${crypto.randomUUID()}`;

interface Props {
  api: RoomApi;
  writer: RoomWriter;
  desk: Loadable<DeskStatus>;
  pairs: Loadable<PairOption[]>;
  /** The owner's provider list (CB-otc-01): each request asks the providers picked here. */
  makers: Loadable<OtcMakers>;
  /** The providers picked; the room keeps the pick so a re-price asks the same ones. */
  picked: string[];
  onPick: (picked: string[]) => void;
  /** A quote that matches what was asked for. */
  onQuote: (quote: RfqQuote) => void;
}

/** Ask for a firm price. There is no price field: the desk names the price (and the form says so). */
export function RequestForm({ api, writer, desk, pairs, makers, picked, onPick, onQuote }: Props) {
  const { t } = otcCopy.useCopy();
  const [pair, setPair] = useState('');
  const [side, setSide] = useState<Side>('buy');
  const [qty, setQty] = useState('');
  const [mismatch, setMismatch] = useState(false);
  // One nonce per intent: sending the same request again reuses it, changing anything starts a new one.
  const nonce = useRef(newNonce());
  const intent = `${pair}|${side}|${qty}|${picked.join(',')}`;
  const lastIntent = useRef(intent);
  if (lastIntent.current !== intent) {
    lastIntent.current = intent;
    nonce.current = newNonce();
  }

  const options = pairs.status === 'ready' ? pairs.data : [];
  const chosen = options.find((p) => p.symbol === pair);
  useEffect(() => {
    if (!pair && options[0]) setPair(options[0].symbol);
  }, [pair, options]);
  const items = useMemo(() => Object.fromEntries(options.map((p) => [p.symbol, p.symbol])), [options]);

  const locked = writer.note.state !== 'none';
  const block = requestBlock({
    signedIn: writer.signedIn,
    desk: deskState(desk),
    pair,
    qty,
    lot: chosen?.lot ?? null,
    locked,
    busy: writer.busy,
  });

  async function submit() {
    if (block !== null || !chosen) return;
    setMismatch(false);
    const result = await writer.run({
      kind: 'rfq',
      id: nonce.current,
      symbol: noteSymbol('request', chosen.symbol),
      // The pick goes as chosen, even empty or over the cap: the desk refuses it by name, and the form never guesses one.
      call: () => api.rfqQuote({ side, baseAsset: chosen.base, quoteAsset: chosen.quote, qty, makerIds: picked }),
    });
    if (result.kind !== 'done') return;
    const q = result.data;
    const matches = q.baseAsset === chosen.base && q.quoteAsset === chosen.quote && q.side === side && compareDecimals(q.qty, qty) === 0;
    setMismatch(!matches);
    if (matches) onQuote(q);
  }

  return (
    <section aria-label={t('Request a price')} className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <h2 className="m-0 text-md font-medium text-fg">{t('Request a price')}</h2>
      {pairs.status === 'loading' ? <Skeleton className="h-10 w-full" /> : null}
      {pairs.status === 'refused' ? <Refusal words={roomWords({ code: pairs.code })} size="inline" /> : null}
      {pairs.status === 'error' ? (
        <Button variant="secondary" size={32} onClick={pairs.retry}>
          {t('Pairs unreadable retry')}
        </Button>
      ) : null}
      {pairs.status === 'empty' || (pairs.status === 'ready' && options.length === 0) ? (
        <p className="m-0 text-sm text-fg-2">{t('No pairs')}</p>
      ) : null}
      {options.length > 0 ? (
        <>
          <Field label={t('Pair')}>
            <Select items={items} value={pair} onValueChange={(v) => setPair(String(v))}>
              <SelectTrigger className="w-full" size={40} aria-label={t('Pair')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((p) => (
                  <SelectItem key={p.symbol} value={p.symbol}>
                    {p.symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <SegmentedControl
            aria-label={t('Side')}
            size={40}
            fullWidth
            value={side}
            onValueChange={(v) => setSide(v === 'sell' ? 'sell' : 'buy')}
            items={[
              { value: 'buy', label: t('Buy'), tone: 'up' },
              { value: 'sell', label: t('Sell'), tone: 'down' },
            ]}
          />
          <Field label={t('Quantity')} hint={chosen ? t('Quantity hint', { asset: chosen.base }) : undefined}>
            <Input
              kind="decimal"
              value={qty}
              onValueChange={setQty}
              precision={fractionDigits(chosen?.lot) ?? 8}
              trailing={chosen?.base}
              placeholder="0"
            />
          </Field>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="text-sm text-fg">{t('Providers')}</legend>
            {makers.status === 'loading' ? <Skeleton className="h-8 w-full" /> : null}
            {makers.status === 'refused' ? <Refusal words={roomWords({ code: makers.code })} size="inline" /> : null}
            {makers.status === 'error' ? (
              <Button variant="secondary" size={32} onClick={makers.retry}>
                {t('Providers unreadable retry')}
              </Button>
            ) : null}
            {makers.status === 'ready' && !makers.data.published ? <p className="m-0 text-sm text-fg-2">{t('No providers set')}</p> : null}
            {makers.status === 'ready' && makers.data.published ? (
              <>
                {makers.data.makers.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm text-fg">
                    <Checkbox
                      checked={picked.includes(m.id)}
                      onCheckedChange={(on) => onPick(on ? [...new Set([...picked, m.id])] : picked.filter((id) => id !== m.id))}
                    />
                    <span>{m.name}</span>
                  </label>
                ))}
                {makers.data.selectCap != null ? (
                  <p className="m-0 text-xs text-fg-2">{t('Providers hint', { cap: String(makers.data.selectCap) })}</p>
                ) : null}
              </>
            ) : null}
          </fieldset>
          <p className="m-0 text-xs text-fg-2">{t('Desk names the price')}</p>
          <Button variant="primary" size={40} loading={writer.busy} disabled={block !== null} onClick={() => void submit()}>
            {t('Request price')}
          </Button>
          {block !== null ? (
            <p className="m-0 text-xs text-fg-2" data-testid="request-block">
              {t(BLOCK_KEY[block])}
            </p>
          ) : null}
        </>
      ) : null}
      {mismatch ? (
        <p role="alert" className="m-0 text-sm text-warn">
          {t('Quote mismatch')}
        </p>
      ) : null}
    </section>
  );
}
