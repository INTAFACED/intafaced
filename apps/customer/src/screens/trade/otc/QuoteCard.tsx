import { useState } from 'react';
import { CircleCheck, CircleDashed, CircleHelp, CircleSlash, Hourglass, TriangleAlert } from 'lucide-react';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { RoomApi, RfqQuote } from '../rooms/api';
import { Freshness, Refusal } from '../rooms/RoomNotices';
import { compareDecimals } from '../rooms/math';
import { roomWords } from '../rooms/refusals';
import type { RoomWriter } from '../rooms/write';
import type { BadgeTone } from '@intafaced/ui';
import { Badge, Button, KeyValue, fmtAmount, fmtPrice } from '../rooms/ui';
import { otcCopy } from './copy';
import { ConfirmDialog, type Confirming } from './ConfirmDialog';
import {
  allowedActions,
  atOf,
  chipOf,
  costOf,
  countdownOf,
  lifecycleOf,
  noteSymbol,
  phaseOf,
  sameQuote,
  type Chip,
  type Phase,
} from './model';

const LIFE_LOOK: Record<Chip, { tone: BadgeTone; icon: typeof CircleCheck }> = {
  open: { tone: 'lime', icon: CircleDashed },
  bound: { tone: 'warn', icon: Hourglass },
  settled: { tone: 'up', icon: CircleCheck },
  expired: { tone: 'neutral', icon: CircleSlash },
  unknown: { tone: 'neutral', icon: CircleHelp },
  unconfirmed: { tone: 'warn', icon: TriangleAlert },
  'time-up': { tone: 'warn', icon: Hourglass },
};

/** The lifecycle as a shape and a word, the same chip in the table and on the card. */
export function LifecycleChip({ lifecycle }: { lifecycle: Chip }) {
  const { t } = otcCopy.useCopy();
  const { tone, icon: Icon } = LIFE_LOOK[lifecycle];
  return (
    <Badge tone={tone} variant="outline" density="dense" icon={<Icon size={12} />}>
      {t(`Life ${lifecycle}`)}
    </Badge>
  );
}

const PHASE_LINE: Record<
  Phase | 'unconfirmed',
  'Phase unconfirmed' | 'Phase open' | 'Phase open-late' | 'Phase bound' | 'Phase settled' | 'Phase expired' | 'Phase unknown'
> = {
  open: 'Phase open',
  'open-late': 'Phase open-late',
  bound: 'Phase bound',
  settled: 'Phase settled',
  expired: 'Phase expired',
  unknown: 'Phase unknown',
  unconfirmed: 'Phase unconfirmed',
};

interface Props {
  api: RoomApi;
  writer: RoomWriter;
  quote: RfqQuote;
  readAt: number;
  now: number;
  /** The providers this quote asked, or the room's current pick when the room did not see it asked (a reload or a link). */
  providers: string[];
  /** Re-read the quote from the service (and release a device note if that proves the outcome). */
  onCheck: (id: string) => Promise<void>;
  /** Show a quote a write just returned; `select` opens it in place of this one (a re-price). */
  onQuote: (quote: RfqQuote, options?: { select?: boolean; asked?: string[] }) => void;
}

/** One quote in full: the returned numbers, the all-in cost, the live countdown, and what may be done to it now. */
export function QuoteCard({ api, writer, quote, readAt, now, providers, onCheck, onQuote }: Props) {
  const { t } = otcCopy.useCopy();
  const { timeZone } = usePreferences();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [checking, setChecking] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const life = lifecycleOf(quote);
  const phase = phaseOf(quote, now);
  const chip = chipOf(quote, now, writer.note.state === 'pending' ? writer.note.pending.id : null);
  const allowed = allowedActions(phase);
  const countdown = countdownOf(quote.expiresAt, now);
  const cost = costOf(quote);
  const pair = `${quote.baseAsset}/${quote.quoteAsset}`;
  const at = (iso: string | null | undefined) => {
    const ms = atOf(iso);
    return ms === null ? null : dayTime(ms, timeZone);
  };
  const expiresText = at(quote.expiresAt) ?? '—';
  const locked = writer.note.state !== 'none';
  const lockedWhy = locked ? t('Block locked') : writer.busy ? t('Block busy') : null;

  const money = (value: string | null) => (value === null ? null : `${fmtAmount(value)} ${quote.quoteAsset}`);
  const items = [
    { label: t('Quote id'), value: quote.quoteId, mono: true },
    { label: t('Pair'), value: pair },
    { label: t('Side'), value: quote.side === 'buy' ? t('Buy') : t('Sell') },
    { label: t('Quantity'), value: `${fmtAmount(quote.qty)} ${quote.baseAsset}` },
    { label: t('Mid price'), value: `${fmtPrice(quote.midPrice, null)} ${quote.quoteAsset}` },
    { label: t('Spread'), value: `${cost.spreadBps} bps` },
    { label: t('Spread notional'), value: money(cost.spreadReturned) },
    { label: cost.direction === 'pay' ? t('You pay') : t('You receive'), value: money(cost.value), hint: t('Value spread included') },
    { label: t('Mid value'), value: money(cost.midValue) },
    {
      label: t('Spread cost'),
      value: money(cost.spreadCost),
      hint:
        cost.spreadCost !== null && !cost.agrees
          ? t('Spread figures differ', { returned: money(cost.spreadReturned) ?? '—' })
          : t('Spread cost note'),
    },
    { label: t('Fee'), value: t('Fee zero') },
    { label: t('Counterparty'), value: `${quote.counterparty} · ${quote.counterpartyId}` },
    { label: t('Created'), value: at(quote.createdAt) },
    {
      label: t('Expires'),
      value:
        life === 'open'
          ? `${expiresText} · ${
              chip === 'unconfirmed'
                ? t('Time unconfirmed')
                : countdown.state === 'firm'
                  ? t('Time left', { time: countdown.text })
                  : t('Time is up')
            }`
          : expiresText,
    },
    ...(quote.acceptedAt || quote.fillPrice
      ? [
          { label: t('Accepted'), value: at(quote.acceptedAt) },
          { label: t('Original fill price'), value: quote.fillPrice ? `${fmtPrice(quote.fillPrice, null)} ${quote.quoteAsset}` : null },
        ]
      : []),
  ];

  /**
   * Re-price an expired quote: a new request for the same pair, side and size to the same providers (CB-otc-01): the
   * maker that quoted in maker mode, else the providers it asked. The old quote stays expired.
   */
  async function askAgain() {
    setMismatch(false);
    const asked = quote.counterparty === 'maker' ? [quote.counterpartyId] : providers;
    const result = await writer.run<RfqQuote>({
      kind: 'rfq',
      id: `otc-req-${crypto.randomUUID()}`,
      symbol: noteSymbol('request', pair),
      call: () =>
        api.rfqQuote({
          side: quote.side,
          baseAsset: quote.baseAsset,
          quoteAsset: quote.quoteAsset,
          qty: quote.qty,
          makerIds: asked,
          ...(quote.counterparty === 'maker' ? { makerId: quote.counterpartyId } : {}),
        }),
    });
    if (result.kind !== 'done') return;
    const q = result.data;
    // Same check as a fresh request: a quote for anything other than what was asked is not shown.
    const matches =
      q.baseAsset === quote.baseAsset &&
      q.quoteAsset === quote.quoteAsset &&
      q.side === quote.side &&
      compareDecimals(q.qty, quote.qty) === 0;
    setMismatch(!matches);
    if (matches) onQuote(q, { select: true, asked });
  }

  async function send(action: Confirming) {
    const id = quote.quoteId;
    const result = await writer.run<unknown>({
      kind: 'rfq',
      id,
      symbol: noteSymbol(action, pair),
      call: () =>
        action === 'accept' ? api.rfqAccept(id, quote.quotedPrice) : action === 'expire' ? api.rfqExpire(id) : api.otcSettle(id),
    });
    setConfirming(null);
    if (result.kind === 'done' && action !== 'settle' && sameQuote(id, result.data as RfqQuote)) onQuote(result.data as RfqQuote);
    // Whatever the answer was, the service now holds the truth: read it back so the card never shows a guess.
    if (result.kind !== 'blocked') await onCheck(id);
  }

  const confirmBlock = confirming === 'accept' && phase !== 'open' ? t('Phase open-late') : lockedWhy;

  return (
    <section
      aria-label={t('Quote')}
      data-quote-id={quote.quoteId}
      className="flex flex-col gap-3 rounded-md border border-line bg-panel p-3"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="m-0 text-md font-medium text-fg">{t('Quote title', { pair })}</h3>
        <LifecycleChip lifecycle={chip} />
        <Freshness asOf={readAt} now={now} />
      </header>
      <p className="m-0 text-sm text-fg" role="status" data-testid="phase-line">
        {t(PHASE_LINE[chip === 'unconfirmed' ? 'unconfirmed' : phase])}
      </p>
      <p className="m-0 text-lg font-medium text-fg tabular-nums">
        {t('Quoted price')}: <span data-testid="quote-price">{`${fmtPrice(quote.quotedPrice, null)} ${quote.quoteAsset}`}</span>
      </p>
      {life === 'expired' ? <Refusal words={roomWords({ code: 'trade.otc_quote_expired' })} size="inline" /> : null}
      {life === 'bound' ? (
        <p className="m-0 text-sm text-fg">
          {t('Settle window')}:{' '}
          <span data-testid="settle-by">
            {at(quote.settleBy) === null
              ? t('Settle window unread')
              : quote.settleWindowMs == null
                ? t('Settle window not set', { time: at(quote.settleBy) ?? '' })
                : t('Settle by', { time: at(quote.settleBy) ?? '' })}
          </span>
        </p>
      ) : null}
      <KeyValue density="dense" items={items} now={now} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size={32}
          disabled={!allowed.includes('accept') || lockedWhy !== null}
          onClick={() => setConfirming('accept')}
        >
          {t('Accept')}
        </Button>
        <Button
          variant="primary"
          size={32}
          disabled={!allowed.includes('settle') || lockedWhy !== null}
          onClick={() => setConfirming('settle')}
        >
          {t('Settle')}
        </Button>
        <Button
          variant="secondary"
          size={32}
          disabled={!allowed.includes('expire') || lockedWhy !== null}
          onClick={() => setConfirming('expire')}
        >
          {t('Expire')}
        </Button>
        {life === 'expired' ? (
          <Button variant="primary" size={32} disabled={lockedWhy !== null} onClick={() => void askAgain()}>
            {t('Ask again')}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size={32}
          loading={checking}
          onClick={() => {
            setChecking(true);
            void onCheck(quote.quoteId).finally(() => setChecking(false));
          }}
        >
          {t('Check status')}
        </Button>
      </div>
      {mismatch ? (
        <p role="alert" className="m-0 text-sm text-warn">
          {t('Quote mismatch')}
        </p>
      ) : null}
      {lockedWhy ? <p className="m-0 text-xs text-fg-2">{lockedWhy}</p> : null}
      <p className="m-0 text-xs text-fg-2">{t('Buttons note')}</p>
      <ConfirmDialog
        action={confirming}
        quote={quote}
        countdown={countdown}
        expiresText={expiresText}
        sending={writer.busy}
        blockedWhy={confirmBlock}
        onConfirm={() => confirming && void send(confirming)}
        onClose={() => setConfirming(null)}
      />
    </section>
  );
}
