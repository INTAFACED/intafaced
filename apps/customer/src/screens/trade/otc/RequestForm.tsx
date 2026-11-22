import { useEffect, useRef, useState } from 'react';
import { fractionDigits } from '../../../data/decimal';
import type { DeskStatus, OtcMakers } from '../rooms/api';
import { roomWords } from '../rooms/refusals';
import type { RoomApi } from '../rooms/api';
import type { RoomWriter } from '../rooms/write';
import { Button, Checkbox, DecimalField, Segmented, Select } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { Loadable } from '../rooms/ui';
import { Refusal } from '../options/notices';
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
  onQuote: (quote: RfqQuote, providers: string[]) => void;
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
    const asked = picked;
    const result = await writer.run({
      kind: 'rfq',
      id: nonce.current,
      symbol: noteSymbol('request', chosen.symbol),
      // The pick goes as chosen, even empty or over the cap: the desk refuses it by name, and the form never guesses one.
      call: () => api.rfqQuote({ side, baseAsset: chosen.base, quoteAsset: chosen.quote, qty, makerIds: asked }),
    });
    if (result.kind !== 'done') return;
    const q = result.data;
    const matches = q.baseAsset === chosen.base && q.quoteAsset === chosen.quote && q.side === side && compareDecimals(q.qty, qty) === 0;
    setMismatch(!matches);
    if (matches) onQuote(q, asked);
  }

  return (
    <section aria-label={t('Request a price')} className="lt-stack">
      <h2 className="lt-heading">{t('Request a price')}</h2>
      {pairs.status === 'loading' ? <Skeleton shape="form" count={1} /> : null}
      {pairs.status === 'refused' ? <Refusal words={roomWords({ code: pairs.code })} /> : null}
      {pairs.status === 'error' ? <Button onClick={pairs.retry}>{t('Pairs unreadable retry')}</Button> : null}
      {pairs.status === 'empty' || (pairs.status === 'ready' && options.length === 0) ? <p className="lt-hint">{t('No pairs')}</p> : null}
      {options.length > 0 ? (
        <>
          <Select label={t('Pair')} value={pair} onChange={setPair} options={options.map((p) => ({ value: p.symbol, label: p.symbol }))} />
          <Segmented
            label={t('Side')}
            value={side}
            onChange={(v) => setSide(v === 'sell' ? 'sell' : 'buy')}
            options={[
              { value: 'buy', label: t('Buy') },
              { value: 'sell', label: t('Sell') },
            ]}
          />
          <DecimalField
            label={t('Quantity')}
            hint={chosen ? t('Quantity hint', { asset: chosen.base }) : undefined}
            value={qty}
            onValueChange={setQty}
            precision={fractionDigits(chosen?.lot) ?? 8}
            unit={chosen?.base}
            placeholder="0"
          />
          <fieldset className="lt-stack lt-group">
            <legend>{t('Providers')}</legend>
            {makers.status === 'loading' ? <Skeleton shape="rows" count={2} /> : null}
            {makers.status === 'refused' ? <Refusal words={roomWords({ code: makers.code })} /> : null}
            {makers.status === 'error' ? <Button onClick={makers.retry}>{t('Providers unreadable retry')}</Button> : null}
            {makers.status === 'ready' && !makers.data.published ? <p className="lt-hint">{t('No providers set')}</p> : null}
            {makers.status === 'ready' && makers.data.published ? (
              <>
                {makers.data.makers.map((m) => (
                  <Checkbox
                    key={m.id}
                    label={m.name}
                    checked={picked.includes(m.id)}
                    onChange={(on) => onPick(on ? [...new Set([...picked, m.id])] : picked.filter((id) => id !== m.id))}
                  />
                ))}
                {makers.data.selectCap != null ? (
                  <p className="lt-hint">{t('Providers hint', { cap: String(makers.data.selectCap) })}</p>
                ) : null}
              </>
            ) : null}
          </fieldset>
          <p className="lt-hint">{t('Desk names the price')}</p>
          <Button
            tone="primary"
            size="lg"
            aria-busy={writer.busy || undefined}
            disabled={block !== null || writer.busy}
            onClick={() => void submit()}
          >
            {t('Request price')}
          </Button>
          {block !== null ? (
            <p className="lt-hint" data-testid="request-block">
              {t(BLOCK_KEY[block])}
            </p>
          ) : null}
        </>
      ) : null}
      {mismatch ? (
        <p role="alert" className="lt-alert">
          {t('Quote mismatch')}
        </p>
      ) : null}
    </section>
  );
}
