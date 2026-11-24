/**
 * A large conversion at the quote desk's price (CB-otc-12), on the Convert page. The desk names the price; the owner's
 * size range for conversions is shown as published, or "Not set" (and the desk then refuses every request). Confirming
 * accepts the firm price and settles it, both through the desk's own doors (`rfq.accept`, `otc.settle`). An unconfirmed
 * step is noted the way the quote desk notes its own (kind `rfq`, the quote id, `accept:`/`settle:`), so either room
 * can check it; this panel shows and checks only those notes, and leaves any other room's note to the Convert card.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleSlash } from 'lucide-react';
import { Button, Segmented, Tag } from '@intafaced/ui/lit';
import { DecimalInput, KeyValue, Select, Skeleton } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPrice, type Loadable } from '../../../data';
import { fractionDigits } from '../../../data/decimal';
import { usePreferences } from '../../../shared/preferences';
import { VerifyFirstNote } from '../../../shared/verify-first';
import { dayTime } from '../desk/time';
import { KitState } from '../kit-parts';
import type { ConvertBounds, OtcConvertQuote, RfqFill, RoomApi } from '../rooms/api';
import { compareDecimals } from '../rooms/math';
import { ROOM_INTERVALS, useNow, usePrivateRead, useRoomApi } from '../rooms/read';
import { roomWords, type Words } from '../rooms/refusals';
import { BLOCK_WORDS, useRoomWriter, type RoomWriter } from '../rooms/write';
import { useDeskStatus, usePairs, type PairOption } from '../otc/data';
import { otcCopy } from '../otc/copy';
import { atOf, lifecycleOf, noteSymbol, operationOf, verdictOf } from '../otc/model';
import { convertCopy } from './copy';

type Side = 'buy' | 'sell';
const newNonce = () => `otc-convert-${crypto.randomUUID()}`;

function useConvertBounds(api: RoomApi): Loadable<ConvertBounds> {
  return usePrivateRead<ConvertBounds>('otc-convert-bounds', (signal) => api.otcConvertBounds(signal), ROOM_INTERVALS.deskStatus);
}

/** The desk section's element id: Convert's "Use the quote desk" moves focus here (J-cex-spot-11 #9). */
export const OTC_DESK_ID = 'cvt-otc';

function OtcRefusal({ words, onRetry }: { words: Words; onRetry?: () => void }) {
  const { t } = convertCopy.useCopy();
  if (words.verify) return <VerifyFirstNote />;
  return (
    <KitState
      kind="refused"
      title={words.title}
      body={words.body}
      code={words.code ?? undefined}
      action={onRetry ? { label: t('Retry'), onClick: onRetry } : undefined}
    />
  );
}

function OtcWriteNotice({ writer, onCheck, done }: { writer: RoomWriter; onCheck?: (id: string) => void; done?: ReactNode }) {
  const { t } = convertCopy.useCopy();
  const { outcome, note } = writer;
  const pendingId = note.state === 'pending' ? note.pending.id : outcome.kind === 'uncertain' ? outcome.id : null;
  return (
    <div className="lt-stack" aria-live="polite">
      {outcome.kind === 'done' && done ? <p>{done}</p> : null}
      {outcome.kind === 'refused' ? <OtcRefusal words={outcome.words} /> : null}
      {outcome.kind === 'blocked' ? (
        <p role="alert" className="lt-refusal">
          {BLOCK_WORDS[outcome.reason]}
        </p>
      ) : null}
      {outcome.kind === 'uncertain' ? (
        <p role="alert" className="lt-refusal">
          {outcome.words.title}. {outcome.words.body}
        </p>
      ) : null}
      {note.state === 'unreadable' ? (
        <p role="alert" className="lt-refusal">
          {BLOCK_WORDS.unreadable}
        </p>
      ) : null}
      {pendingId ? (
        <div className="lt-toolbar">
          <span className="lt-hint">
            {t('OTC unconfirmed')} <span className="lt-mono">{pendingId}</span>. {t('OTC unconfirmed locked')}
          </span>
          {onCheck ? (
            <Button tone="secondary" size="sm" onClick={() => onCheck(pendingId)}>
              {t('OTC check status')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function OtcConvert() {
  const { t } = convertCopy.useCopy();
  const { t: deskT } = otcCopy.useCopy();
  const now = useNow(1_000);
  const { timeZone } = usePreferences();
  const api = useRoomApi();
  const writer = useRoomWriter();
  const desk = useDeskStatus(api);
  const pairs = usePairs(api);
  const bounds = useConvertBounds(api);
  const [pair, setPair] = useState('');
  const [side, setSide] = useState<Side>('buy');
  const [qty, setQty] = useState('');
  const [quote, setQuote] = useState<OtcConvertQuote | null>(null);
  const [filled, setFilled] = useState<RfqFill | null>(null);
  const [mismatch, setMismatch] = useState(false);
  // The quote whose accept the service has confirmed, so a confirm after an unconfirmed accept only settles.
  const [boundId, setBoundId] = useState<string | null>(null);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const nonce = useRef(newNonce());
  const intent = `${pair}|${side}|${qty}`;
  const lastIntent = useRef(intent);
  if (lastIntent.current !== intent) {
    lastIntent.current = intent;
    nonce.current = newNonce();
  }
  // A price is for the request it answered: changing the pair, side or amount takes it off the page.
  useEffect(() => {
    setQuote(null);
    setMismatch(false);
  }, [intent]);

  // Pairs whose base the desk lists; with no list (or no desk) every real spot pair is offered and the desk refuses.
  const listed = desk.status === 'ready' && desk.data.assets?.length ? desk.data.assets : null;
  const options: PairOption[] = useMemo(
    () => (pairs.status === 'ready' ? pairs.data.filter((p) => !listed || listed.includes(p.base)) : []),
    [pairs, listed],
  );
  const chosen = options.find((p) => p.symbol === pair);
  // The first offered pair, and again whenever the chosen one stops being offered (the desk's list changed).
  useEffect(() => {
    if (options[0] && !options.some((p) => p.symbol === pair)) setPair(options[0].symbol);
  }, [pair, options]);
  const selectOptions = useMemo(() => options.map((p) => ({ value: p.symbol, label: p.symbol })), [options]);

  const at = (iso: string | null | undefined) => {
    const ms = atOf(iso);
    return ms === null ? null : dayTime(ms, timeZone);
  };
  const range = bounds.status === 'ready' ? bounds.data.convert : null;
  const locked = writer.note.state !== 'none';
  // Only this panel's (or the quote desk's) notes are shown and checked here; another room's note is the Convert card's.
  const deskNote = writer.note.state === 'pending' && operationOf(writer.note.pending.symbol) !== null;
  const shown = writer.note.state === 'pending' && !deskNote ? { ...writer, note: { state: 'none' as const } } : writer;
  const expired = quote ? (atOf(quote.expiresAt) ?? 0) <= now : false;
  const sizeOk = /^\d+(\.\d+)?$/.test(qty) && (compareDecimals(qty, '0') ?? 0) > 0;
  const canAsk = Boolean(chosen) && sizeOk && !locked && !writer.busy;

  async function ask() {
    if (!chosen || !canAsk) return;
    setQuote(null);
    setFilled(null);
    setMismatch(false);
    setCheckNote(null);
    const asked = intent;
    const result = await writer.run({
      kind: 'rfq',
      id: nonce.current,
      symbol: noteSymbol('request', chosen.symbol),
      call: () => api.otcConvertQuote({ flow: 'convert', side, baseAsset: chosen.base, quoteAsset: chosen.quote, qty }),
    });
    // The form changed while the desk answered: that price is for a request no longer on the page.
    if (result.kind !== 'done' || lastIntent.current !== asked) return;
    const q = result.data;
    const matches = q.baseAsset === chosen.base && q.quoteAsset === chosen.quote && q.side === side && compareDecimals(q.qty, qty) === 0;
    setMismatch(!matches);
    if (matches) setQuote(q);
  }

  async function confirm() {
    if (!quote) return;
    setCheckNote(null);
    const pairName = `${quote.baseAsset}/${quote.quoteAsset}`;
    // The id is the quote's own, as the quote desk keys it, so a retried confirm is the same request, never a second one.
    if (boundId !== quote.quoteId) {
      const accepted = await writer.run({
        kind: 'rfq',
        id: quote.quoteId,
        symbol: noteSymbol('accept', pairName),
        call: () => api.rfqAccept(quote.quoteId, quote.quotedPrice),
      });
      if (accepted.kind !== 'done') return;
      setBoundId(quote.quoteId);
    }
    const settled = await writer.run({
      kind: 'rfq',
      id: quote.quoteId,
      symbol: noteSymbol('settle', pairName),
      call: () => api.otcSettle(quote.quoteId),
    });
    if (settled.kind === 'done') {
      setFilled(settled.data);
      setQuote(null);
    }
  }

  /**
   * Re-read the quote a desk note names. The note is released only when the reading proves what happened to the
   * original step (the quote desk's own rule); a price request holds nothing and has no id to read, so it is released.
   */
  async function check(id: string) {
    setCheckNote(null);
    const mine = writer.note.state === 'pending' && writer.note.pending.id === id ? writer.note.pending : null;
    const operation = mine ? operationOf(mine.symbol) : null;
    if (!mine || !operation) return;
    if (operation === 'request') {
      writer.resolve(id);
      setCheckNote(deskT('Check request released'));
      return;
    }
    const read = await api.rfqGet(id);
    if (!read.ok) {
      setCheckNote(deskT('Check could not read', { id }));
      return;
    }
    const life = lifecycleOf(read.data);
    const verdict = verdictOf(operation, life);
    if (verdict === 'unresolved') {
      setCheckNote(deskT('Check unresolved', { id }));
      return;
    }
    writer.resolve(id);
    if (life === 'bound') setBoundId(id);
    if (life === 'settled' || life === 'expired') setQuote((q) => (q?.quoteId === id ? null : q));
    setCheckNote(verdict === 'done' ? deskT('Check done', { id }) : deskT('Check not done', { id }));
  }

  const settleWords = (q: OtcConvertQuote) =>
    q.settleWindowMs == null
      ? t('OTC settles by expiry', { time: at(q.expiresAt) ?? '—' })
      : t('OTC settles within', { seconds: String(Math.round(q.settleWindowMs / 1000)) });

  return (
    <section id={OTC_DESK_ID} tabIndex={-1} aria-label={t('OTC title')} className="lt-stack">
      <h2>{t('OTC title')}</h2>
      <p className="lt-hint">{t('OTC lead')}</p>
      <div data-testid="convert-otc-range" className="lt-toolbar">
        {t('OTC range')}
        {bounds.status === 'loading' ? <Skeleton shape="text" count={1} /> : null}
        {bounds.status === 'refused' ? <OtcRefusal words={roomWords({ code: bounds.code })} /> : null}
        {bounds.status === 'error' || bounds.status === 'empty' ? <span className="lt-hint">{t('OTC range unread')}</span> : null}
        {bounds.status === 'ready' && range ? (
          <span className="lt-num">
            {t('OTC range value', { min: fmtAmount(range.minQty), max: fmtAmount(range.maxQty), asset: chosen?.base ?? '' })}
          </span>
        ) : null}
        {bounds.status === 'ready' && !range ? (
          <>
            <Tag tone="warn">
              <CircleSlash size={12} aria-hidden="true" />
              {t('Not set')}
            </Tag>
            <span className="lt-hint">{t('OTC range not set')}</span>
          </>
        ) : null}
      </div>
      {bounds.status === 'ready' && !range ? <p data-testid="convert-otc-closed">{t('OTC closed')}</p> : null}
      {pairs.status === 'loading' ? <Skeleton shape="form" count={1} /> : null}
      {pairs.status === 'refused' ? <OtcRefusal words={roomWords({ code: pairs.code })} /> : null}
      {pairs.status !== 'loading' && pairs.status !== 'refused' && options.length === 0 ? (
        <p className="lt-hint">{t('OTC no pairs')}</p>
      ) : null}
      {options.length > 0 ? (
        <div className="lt-stack">
          <div className="lt-field">
            <span className="lt-hint">{t('OTC pair')}</span>
            <Select label={t('OTC pair')} options={selectOptions} value={pair} onChange={(v) => setPair(v)} />
          </div>
          <Segmented
            label={t('OTC side')}
            value={side}
            onChange={(v) => setSide(v === 'sell' ? 'sell' : 'buy')}
            options={[
              { value: 'buy', label: t('OTC buy') },
              { value: 'sell', label: t('OTC sell') },
            ]}
          />
          <DecimalInput
            label={t('OTC quantity')}
            hint={chosen ? t('OTC quantity hint', { asset: chosen.base }) : undefined}
            value={qty}
            onValueChange={setQty}
            precision={fractionDigits(chosen?.lot) ?? 8}
            unit={chosen?.base}
            placeholder="0"
          />
          <Button
            tone="secondary"
            disabled={!canAsk || (writer.busy && !quote)}
            aria-busy={(writer.busy && !quote) || undefined}
            onClick={() => void ask()}
          >
            {t('OTC ask')}
          </Button>
        </div>
      ) : null}
      {mismatch ? (
        <p role="alert" className="lt-refusal">
          {t('OTC mismatch')}
        </p>
      ) : null}
      {quote ? (
        <div data-testid="convert-otc-price" className="lt-region lt-stack">
          <p className="lt-num">
            {t('OTC price')}:{' '}
            <span data-testid="convert-otc-quoted">
              {t('OTC price value', { price: fmtPrice(quote.quotedPrice, null), asset: quote.quoteAsset })}
            </span>
          </p>
          <p data-testid="convert-otc-settles">{settleWords(quote)}</p>
          <KeyValue
            label={t('OTC price')}
            rows={[
              { label: t('OTC quantity'), value: `${fmtAmount(quote.qty)} ${quote.baseAsset}` },
              {
                label: quote.side === 'buy' ? t('OTC you pay') : t('OTC you receive'),
                value: `${fmtAmount(quote.userNotional)} ${quote.quoteAsset}`,
                note: t('OTC spread included', { bps: String(quote.spreadBps) }),
              },
              { label: t('OTC firm until'), value: at(quote.expiresAt) ?? '—' },
              { label: t('OTC quote id'), value: quote.quoteId, ltr: true },
            ]}
          />
          {expired ? (
            <p role="alert" className="lt-refusal">
              {t('OTC expired')}
            </p>
          ) : null}
          <Button
            tone="primary"
            disabled={locked || writer.busy || expired}
            aria-busy={writer.busy || undefined}
            onClick={() => void confirm()}
          >
            {t('OTC confirm')}
          </Button>
        </div>
      ) : null}
      {checkNote ? (
        <p role="status" className="lt-hint">
          {checkNote}
        </p>
      ) : null}
      <OtcWriteNotice
        writer={shown}
        onCheck={(id) => void check(id)}
        done={
          filled ? (
            <span data-testid="convert-otc-done">
              {t('OTC done', {
                qty: fmtAmount(filled.qty),
                base: filled.baseAsset,
                notional: fmtAmount(filled.fillNotional),
                quote: filled.quoteAsset,
                price: fmtPrice(filled.fillPrice, null),
              })}
            </span>
          ) : undefined
        }
      />
    </section>
  );
}
