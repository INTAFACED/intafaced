/**
 * Convert on the person's own venue account (J-cex-spot-11 under the launch money model, docs/adr/2026-11-10-launch-money-model.md).
 * We hold none of the person's money: a price is the venue's best price bounded by the owner's slippage limit and holds
 * nothing; Convert now signs one venue order in the person's wallet; Recent conversions reads the venue's own fills. The
 * room keeps the Convert layout (card, pickers, review, recent list); every figure is the venue's, with its TEST label.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, CoinMark, DecimalField, EmptyState, RefusalBox } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { AssetPicker, type PickerItem } from '../buy/AssetPicker';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useNow } from '../../../shared/use-now';
import { useDeviceStored } from '../../../shared/device-stored';
import { useSession } from '../../../features/session/session';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  draftId,
  preparedStep,
  walletTypedData,
  type PreparedAnswer,
  type VenueOrder,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  venueConvertApi,
  type CashOffer,
  type Conversion,
  type ConvertPair,
  type ConvertQuote,
} from '../../../features/trade/venue-convert-api';
import type { VenueMode } from '../../../features/trade/use-venue-mode';
import { useOwner, useVenueAccount, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { BalancesPanel, TestMark, VenueFrame } from '../../../features/trade/venue/VenueParts';
import { WalletBar } from '../../../features/trade/venue/WalletBar';
import { DepositDialog } from '../desk/DepositDialog';
import { convertCopy } from './copy';
import { venueConvertCopy } from './venue-convert-copy';
import { OTC_DESK_ID } from './OtcConvert';

type T = ReturnType<typeof venueConvertCopy.useCopy>['t'];
const POLL_MS = 5_000;

/** A read that failed, with Try again: what the old error block said, from the kit's refusal. */
function ReadFailed({ title, onRetry }: { title: string; onRetry: () => void }) {
  const { t: ct } = convertCopy.useCopy();
  return (
    <RefusalBox refusal={{ variant: 'unreachable', title, body: '' }} role="alert" data-kind="error">
      <Button onClick={onRetry}>{ct('Retry')}</Button>
    </RefusalBox>
  );
}

function useConvertApi() {
  const { api } = useSession();
  return useMemo(() => venueConvertApi(api), [api]);
}

function useTimeText(): (iso: string) => string {
  const { timeZone } = usePreferences();
  return useCallback(
    (iso: string) => {
      try {
        return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
      } catch {
        return iso;
      }
    },
    [timeZone],
  );
}

const units = (v: string): bigint | null => {
  try {
    return parseAmount(v.trim());
  } catch {
    return null;
  }
};

/** The pair joining two coins, bought (`to` is its base) or sold. */
function pairOf(pairs: readonly ConvertPair[], from: string, to: string): { pair: ConvertPair; side: 'buy' | 'sell' } | null {
  const buy = pairs.find((p) => p.quote === from && p.base === to);
  if (buy) return { pair: buy, side: 'buy' };
  const sell = pairs.find((p) => p.base === from && p.quote === to);
  return sell ? { pair: sell, side: 'sell' } : null;
}

/**
 * How `from` reaches `to`: the pair joining them, or, for a cash currency the partner converts through a coin (#11), the
 * pair that buys `to` with that coin, as two linked steps.
 */
function joinOf(
  pairs: readonly ConvertPair[],
  cash: readonly CashOffer[],
  from: string,
  to: string,
): { pair: ConvertPair; side: 'buy' | 'sell'; cash: CashOffer | null } | null {
  const direct = pairOf(pairs, from, to);
  if (direct) return { ...direct, cash: null };
  for (const offer of cash.filter((c) => c.asset === from)) {
    const pair = pairs.find((p) => p.quote === offer.via && p.base === to);
    if (pair) return { pair, side: 'buy', cash: offer };
  }
  return null;
}

const reachable = (pairs: readonly ConvertPair[], from: string, cash: readonly CashOffer[] = []) => {
  const via = cash.find((c) => c.asset === from)?.via;
  if (via) return [...new Set(pairs.filter((p) => p.quote === via).map((p) => p.base))].sort();
  return [...new Set(pairs.flatMap((p) => (p.quote === from ? [p.base] : p.base === from ? [p.quote] : [])))].sort();
};

/** The Convert room in venue mode: the card, its review, and Recent conversions. */
type Unconfirmed = { actionKey: string; venueClientOrderId: string };
const unconfirmedKey = (owner: string) => `venue-convert-unconfirmed:${owner}`;
const noop = () => undefined;

/** The conversion this device sent whose answer never came back, if any; anything else stored there reads as none. */
function readUnconfirmed(owner: string): Unconfirmed | null {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(unconfirmedKey(owner)) ?? 'null');
    if (kept && typeof kept === 'object' && 'actionKey' in kept && 'venueClientOrderId' in kept) {
      const { actionKey, venueClientOrderId } = kept;
      if (typeof actionKey === 'string' && typeof venueClientOrderId === 'string') return { actionKey, venueClientOrderId };
    }
  } catch {
    return null;
  }
  return null;
}

export function VenueConvertRoom({
  mode,
  asked,
}: {
  mode: Extract<VenueMode, { mode: 'on' }>;
  asked: { from: string | null; to: string | null };
}) {
  const { t } = venueConvertCopy.useCopy();
  const status = mode.status;
  if (!status.available)
    return (
      <div data-testid="cvt-card" data-mode="venue">
        <ReadFailed title={t('Venue unavailable')} onRetry={mode.reload} />
      </div>
    );
  return (
    <VenueFrame mode={mode}>
      <VenueConvert status={status} asked={asked} />
    </VenueFrame>
  );
}

function VenueConvert({ status, asked }: { status: VenueUp; asked: { from: string | null; to: string | null } }) {
  const { t } = venueConvertCopy.useCopy();
  const { t: ct } = convertCopy.useCopy();
  const convert = useConvertApi();
  const owner = useOwner();
  const pairsRead = usePolled((signal) => convert.pairs(signal), 'cvt-venue-pairs', 15_000);
  const pairs = pairsRead.data;

  let card: React.ReactNode;
  if (!owner)
    card = (
      <section data-testid="cvt-card" data-mode="venue" aria-label={ct('Convert')}>
        <p>{t('Connect to convert')}</p>
      </section>
    );
  else if (!pairs)
    card = (
      <section data-testid="cvt-card" data-mode="venue" aria-label={ct('Convert')} aria-busy={!pairsRead.failure}>
        {pairsRead.failure ? <ReadFailed title={t('Pairs unread')} onRetry={pairsRead.reload} /> : null}
      </section>
    );
  else {
    const askedPair = asked.from && asked.to ? joinOf(pairs.pairs, pairs.cash, asked.from, asked.to) : null;
    card =
      asked.from && asked.to && !askedPair ? (
        <VenueRouteCard from={asked.from} to={asked.to} />
      ) : (
        <VenueCard status={status} owner={owner} pairs={pairs.pairs} cash={pairs.cash} paused={pairs.paused} asked={asked} />
      );
  }
  return (
    <>
      <WalletBar />
      {card}
      {owner ? <VenueRecent owner={owner} test={status.test} /> : null}
    </>
  );
}

function VenueCard({
  status,
  owner,
  pairs,
  cash,
  paused,
  asked,
}: {
  status: VenueUp;
  owner: string;
  pairs: readonly ConvertPair[];
  /** Cash currencies the partner converts through a coin for this person now (#11). */
  cash: readonly CashOffer[];
  paused: boolean;
  asked: { from: string | null; to: string | null };
}) {
  const { t } = venueConvertCopy.useCopy();
  const { t: ct } = convertCopy.useCopy();
  const convert = useConvertApi();
  const wallet = useWallet();
  const account = useVenueAccount(owner);
  const initial = useMemo(() => {
    const p = (asked.from && asked.to && joinOf(pairs, cash, asked.from, asked.to)) || null;
    if (p) return { from: asked.from!, to: asked.to! };
    const first = pairs[0];
    return first ? { from: first.quote, to: first.base } : null;
  }, [pairs, cash, asked]);
  const [chosen, setChosen] = useState(initial);
  const [amount, setAmount] = useState('');
  const [target, setTarget] = useState('');
  const [tab, setTab] = useState<'instant' | 'limit'>('instant');
  const [picker, setPicker] = useState<'from' | 'to' | null>(null);
  const [quote, setQuote] = useState<
    { state: 'idle' } | { state: 'asking' } | { state: 'ready'; quote: ConvertQuote } | { state: 'refused'; detail: string }
  >({
    state: 'idle',
  });
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A conversion whose answer was lost stays on this device until Check again finds it at the venue, so a reload keeps its note.
  const [unknown, setUnknown] = useDeviceStored<Unconfirmed | null>(unconfirmedKey(owner), () => readUnconfirmed(owner), noop);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [done, setDone] = useState<{ actionKey: string; order: VenueOrder | null } | null>(null);
  const [limitDone, setLimitDone] = useState<{ order: VenueOrder | null; venueClientOrderId: string | null } | null>(null);
  const [deposit, setDeposit] = useState(false);
  const now = useNow(500);
  const sending = useRef(false);
  const limitKey = useRef<string | null>(null);
  const venue = useVenueApi();

  if (!chosen)
    return (
      <section data-testid="cvt-card" data-mode="venue" aria-label={ct('Convert')}>
        <EmptyState
          title={ct('No convert title')}
          body={ct('No convert body')}
          data-kind="empty"
          action={
            <a className="lt-link" href="/trade">
              {ct('Go to Markets')}
            </a>
          }
        />
      </section>
    );
  const { from, to } = chosen;
  const joined = joinOf(pairs, cash, from, to);
  const pair = joined?.pair ?? null;
  const side = joined?.side ?? 'buy';
  // A cash currency is paid by the partner's step first (#11): its figure is the partner's, not the trading account's.
  const cashLeg = joined?.cash ?? null;
  const assets = [...new Set([...pairs.flatMap((p) => [p.base, p.quote]), ...cash.map((c) => c.asset)])].sort();
  const balances = account.balances.data;
  const free = cashLeg ? cashLeg.available : balances ? (balances.value.find((b) => b.asset === from)?.free ?? '0') : null;
  const typed = units(amount);
  // Above the per-conversion limit (in the asset being spent) the instant card stops and points to the quote desk.
  const cap = pair?.maxPerConvert && pair.maxPerConvert.asset === from ? pair.maxPerConvert : null;
  const tooLarge = typed !== null && cap !== null && typed > parseAmount(cap.amount);
  const short = !tooLarge && typed !== null && typed > 0n && free !== null && typed > parseAmount(free);
  const min = pair?.minOrderNotional ?? null;
  const tooSmall = !short && !cashLeg && side === 'buy' && typed !== null && typed > 0n && min !== null && typed < parseAmount(min);
  const ready = typed !== null && typed > 0n && !tooLarge && !short && !tooSmall && !paused && pair !== null;
  const shown = quote.state === 'ready' ? quote.quote : null;
  const stale = shown ? now > Date.parse(shown.freshUntil) : false;

  const limitFor = (asset: string, other: string) => {
    const p = pairOf(pairs, asset, other)?.pair ?? pairs.find((x) => x.base === asset) ?? pairs.find((x) => x.quote === asset);
    return p?.maxPerConvert ?? null;
  };
  const items = (list: readonly string[], other: string): PickerItem[] =>
    list.map((asset) => {
      const limit = limitFor(asset, other);
      return {
        asset,
        name: null,
        note: limit ? ct('Limit per conversion', { amount: displayAmount(limit.amount), asset: limit.asset }) : ct('Limit not set'),
      };
    });

  function reset() {
    setQuote({ state: 'idle' });
    setReviewing(false);
    setMessage(null);
    setDone(null);
    setLimitDone(null);
    limitKey.current = null;
  }

  function pick(which: 'from' | 'to', asset: string) {
    setAmount('');
    reset();
    if (which === 'from') {
      const next = reachable(pairs, asset, cash);
      setChosen({ from: asset, to: next.includes(to) ? to : (next[0] ?? to) });
    } else setChosen({ from, to: asset });
    setPicker(null);
  }

  async function getPrice(): Promise<ConvertQuote | null> {
    if (!ready) return null;
    setQuote({ state: 'asking' });
    setMessage(null);
    const answer = await convert.quote({ owner, from, to, amount: formatAmount(typed!), quoteKey: `cq-${draftId()}` });
    if (!answer.ok) {
      setQuote({ state: 'refused', detail: answer.message });
      return null;
    }
    setQuote({ state: 'ready', quote: answer.data });
    return answer.data;
  }

  /** One signed action: the door's prepared order, signed once by the wallet, sent once. */
  async function signAndSend(prepared: PreparedAnswer) {
    const step = preparedStep(prepared, { kept: undefined, refusedBeforeSend: false, promptedHere: true });
    if (step.step === 'outcome') return { kind: 'outcome' as const, outcome: step.outcome };
    if (step.step === 'unknown') return { kind: 'unknown' as const };
    if (step.step === 'wait') return { kind: 'message' as const, text: t('Wallet waiting') };
    if (step.step === 'resend') return { kind: 'unknown' as const };
    const p = prepared.prepared;
    const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(p.typedData) });
    if (signed.status === 'rejected') return { kind: 'message' as const, text: t('Wallet rejected') };
    if (signed.status !== 'signed')
      return { kind: 'message' as const, text: t('Wallet failed', { detail: signed.status === 'failed' ? signed.message : '' }) };
    const sent = await convert.submit(prepared.actionKey, { digest: p.digest, signature: signed.signature, signedBy: owner });
    if (!sent.ok)
      return sent.reason === 'uncertain'
        ? { kind: 'unknown' as const }
        : { kind: 'message' as const, text: t('Convert refused', { detail: sent.message }) };
    if (!sent.data.outcome.definite) return { kind: 'unknown' as const };
    return { kind: 'outcome' as const, outcome: sent.data.outcome };
  }

  async function convertNow() {
    if (sending.current || !shown || stale || paused) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const prepared = await convert.accept({ owner, quoteId: shown.quoteId });
      if (!prepared.ok) {
        setMessage(t('Convert refused', { detail: prepared.message }));
        return;
      }
      const cloid = prepared.data.prepared.venueClientOrderId ?? '';
      const result = await signAndSend(prepared.data);
      if (result.kind === 'message') return setMessage(result.text);
      setReviewing(false);
      if (result.kind === 'unknown') return setUnknown({ actionKey: prepared.data.actionKey, venueClientOrderId: cloid });
      if (!result.outcome.accepted) return setMessage(t('Convert refused', { detail: result.outcome.refusal.detail }));
      setDone({ actionKey: prepared.data.actionKey, order: (result.outcome.order as VenueOrder | null) ?? null });
      account.reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  async function checkAgain() {
    if (!unknown || busy) return;
    setBusy(true);
    setCheckNote(null);
    try {
      const read = await venue.orderByClientId(owner, unknown.venueClientOrderId);
      if (!read.ok) return setCheckNote(t('Check failed', { detail: read.message }));
      if (!read.data.value) return setCheckNote(t('Not on venue'));
      setDone({ actionKey: unknown.actionKey, order: read.data.value });
      setUnknown(null);
      account.reload();
    } finally {
      setBusy(false);
    }
  }

  async function placeLimit() {
    const price = units(target);
    if (sending.current || !ready || price === null || price <= 0n) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      limitKey.current ??= `cl-${draftId()}`;
      const prepared = await convert.limit({
        owner,
        from,
        to,
        amount: formatAmount(typed!),
        price: formatAmount(price),
        limitKey: limitKey.current,
      });
      if (!prepared.ok) return setMessage(t('Convert refused', { detail: prepared.message }));
      const result = await signAndSend(prepared.data);
      if (result.kind === 'message') return setMessage(result.text);
      const cloid = prepared.data.prepared.venueClientOrderId;
      if (result.kind === 'unknown') return setUnknown({ actionKey: prepared.data.actionKey, venueClientOrderId: cloid ?? '' });
      if (!result.outcome.accepted) return setMessage(t('Convert refused', { detail: result.outcome.refusal.detail }));
      setLimitDone({ order: (result.outcome.order as VenueOrder | null) ?? null, venueClientOrderId: cloid });
      limitKey.current = null;
      account.reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const spot = pair ? `/trade/spot/${encodeURIComponent(pair.symbol)}` : '/trade';
  return (
    <section data-testid="cvt-card" data-mode="venue" aria-label={ct('Convert')}>
      <div data-testid="cvt-card__head" className="lt-title-row">
        <h2>
          {ct('Convert')} <TestMark test={status.test} />
        </h2>
      </div>
      <p className="lt-hint">{t('Venue tagline')}</p>
      <div className="lt-tabs" role="tablist" aria-label={ct('Convert mode')}>
        {(['instant', 'limit'] as const).map((value) => (
          <Button
            key={value}
            role="tab"
            tone="quiet"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
              reset();
            }}
          >
            {value === 'limit' ? ct('Limit') : ct('Instant')}
          </Button>
        ))}
      </div>
      <div data-testid="from-field">
        <p className="lt-hint">{ct('From')}</p>
        <div className="lt-toolbar">
          <Button tone="quiet" aria-label={ct('Change From asset')} onClick={() => setPicker('from')}>
            <CoinMark asset={from} size="sm" />
            <span>{from}</span>
          </Button>
          <DecimalField
            label={ct('Amount to convert')}
            labelHidden
            size="hero"
            typedMark="either"
            value={amount}
            onValueChange={(v) => {
              setAmount(v);
              reset();
            }}
            precision={8}
            placeholder="0"
          />
        </div>
        <p className="lt-hint" data-testid="cvt-available">
          {t(cashLeg ? 'Available at partner' : 'Available on venue', { value: free === null ? '—' : displayAmount(free), asset: from })}
        </p>
      </div>
      <div data-testid="to-field">
        <p className="lt-hint">{ct('To')}</p>
        <div className="lt-toolbar">
          <Button tone="quiet" aria-label={ct('Change To asset')} onClick={() => setPicker('to')}>
            <CoinMark asset={to} size="sm" />
            <span>{to}</span>
          </Button>
        </div>
      </div>

      {cashLeg ? (
        <div role="note" data-testid="cvt-linked" data-cash={cashLeg.asset} data-via={cashLeg.via}>
          <p>
            <strong>{t('Linked title')}.</strong> {t('Linked body', { label: cashLeg.label, via: cashLeg.via, from, to })}{' '}
            <TestMark test={cashLeg.test} />
          </p>
        </div>
      ) : null}
      {tooLarge && cap ? (
        <div role="note" data-testid="cvt-too-large">
          <p>
            <strong>{ct('Too large title')}.</strong> {ct('Too large body', { amount: displayAmount(cap.amount), asset: cap.asset })}
          </p>
          <a
            className="lt-link"
            href={`#${OTC_DESK_ID}`}
            onClick={(event) => {
              event.preventDefault();
              const desk = document.getElementById(OTC_DESK_ID);
              desk?.scrollIntoView({ block: 'start' });
              desk?.focus();
            }}
          >
            {ct('Use the quote desk')}
          </a>
        </div>
      ) : null}
      {tooSmall ? (
        <p role="alert" data-testid="cvt-too-small">
          {t('Too small', { min: displayAmount(min), asset: from })}
        </p>
      ) : null}
      {short ? (
        <div role="alert" data-testid="cvt-short">
          <p>{t(cashLeg ? 'Not enough cash' : 'Not enough', { asset: from, value: displayAmount(free) })}</p>
          {cashLeg ? null : (
            <a
              className="lt-link"
              href="#venue-deposit"
              onClick={(event) => {
                event.preventDefault();
                setDeposit(true);
              }}
            >
              {t('Deposit asset', { asset: from })}
            </a>
          )}
        </div>
      ) : null}
      {paused ? (
        <div role="alert" data-testid="cvt-paused" data-code="trade.convert_disabled">
          <p>
            <strong>{t('Paused title')}.</strong> {t('Paused body')}
          </p>
          <a className="lt-link" href={spot}>
            {t('Use Spot')}
          </a>
        </div>
      ) : null}

      {tab === 'instant' ? (
        <>
          {shown ? <QuoteFacts quote={shown} t={t} testid="cvt-quote" /> : null}
          {quote.state === 'refused' ? (
            <p role="alert" data-testid="cvt-quote-refused">
              {t('Price refused', { detail: quote.detail })}
            </p>
          ) : null}
          {shown && !stale ? (
            <Button tone="primary" size="lg" block onClick={() => setReviewing(true)}>
              {t('Review')}
            </Button>
          ) : (
            <Button tone="primary" size="lg" block disabled={!ready || quote.state === 'asking'} onClick={() => void getPrice()}>
              {quote.state === 'asking' ? t('Getting a price') : stale ? t('Get a fresh price') : t('Get a price')}
            </Button>
          )}
        </>
      ) : (
        <div data-testid="cvt-limit">
          <DecimalField
            id="cvt-target"
            label={t('Target rate')}
            typedMark="either"
            value={target}
            onValueChange={setTarget}
            precision={8}
            placeholder="0"
          />
          {pair ? <p className="lt-hint">{t('Target rate hint', { base: pair.base, quote: pair.quote })}</p> : null}
          {cashLeg ? (
            <p role="note" data-testid="cvt-limit-cash">
              {t('Limit cash')}
            </p>
          ) : null}
          <Button
            tone="primary"
            size="lg"
            block
            disabled={!ready || busy || !units(target) || cashLeg !== null}
            onClick={() => void placeLimit()}
          >
            {busy ? t('Placing') : t('Place limit convert')}
          </Button>
          {limitDone && pair ? (
            <p role="status" data-testid="cvt-limit-result" data-client-id={limitDone.venueClientOrderId ?? ''}>
              {limitDone.order?.status === 'filled'
                ? t('Limit filled', { price: displayAmount(limitDone.order.averagePrice ?? limitDone.order.price), quote: pair.quote })
                : t('Limit resting', {
                    side: side === 'buy' ? 'buy' : 'sell',
                    size: displayAmount(limitDone.order?.amount ?? '0'),
                    base: pair.base,
                    price: displayAmount(limitDone.order?.price ?? target),
                    quote: pair.quote,
                  })}
            </p>
          ) : null}
        </div>
      )}
      {message && !reviewing ? (
        <p role="alert" data-testid="cvt-message">
          {message}
        </p>
      ) : null}

      {unknown ? (
        <div role="alert" data-testid="cvt-unknown" data-client-id={unknown.venueClientOrderId}>
          <p>
            <strong>{t('Unknown title')}.</strong> {t('Unknown body')}
          </p>
          <Button disabled={busy} onClick={() => void checkAgain()}>
            {busy ? t('Checking') : t('Check again')}
          </Button>
          {checkNote ? <p role="status">{checkNote}</p> : null}
        </div>
      ) : null}
      {done ? <Receipt owner={owner} done={done} from={from} to={to} /> : null}
      {done || limitDone ? (
        <div data-testid="cvt-balances">
          <h3>{t('New balances')}</h3>
          <BalancesPanel balances={account.balances.data} test={status.test} />
        </div>
      ) : null}

      {reviewing && shown ? (
        <Sheet open title={t('Review conversion')} dismissible={!busy} onClose={() => !busy && setReviewing(false)}>
          <div data-testid="cvt-review">
            <p>{t('Review hint')}</p>
            <QuoteFacts quote={shown} t={t} testid="dlg-breakdown" />
            {stale ? (
              <p role="alert" data-testid="dlg-stale">
                <strong>{t('Stale title')}.</strong> {t('Stale body')}
              </p>
            ) : null}
            {message ? (
              <p role="alert" data-testid="dlg-error">
                {message}
              </p>
            ) : null}
            {stale ? (
              <Button tone="primary" disabled={quote.state === 'asking'} onClick={() => void getPrice()}>
                {t('Get a fresh price')}
              </Button>
            ) : (
              <Button tone="primary" aria-busy={busy || undefined} disabled={busy || paused} onClick={() => void convertNow()}>
                {busy ? t('Converting') : t('Convert now')}
              </Button>
            )}{' '}
            <Button disabled={busy} onClick={() => setReviewing(false)}>
              {t('Close review')}
            </Button>
          </div>
        </Sheet>
      ) : null}
      <AssetPicker
        open={picker !== null}
        onOpenChange={(open) => !open && setPicker(null)}
        title={ct('Choose asset')}
        searchLabel={ct('Search assets')}
        noMatch={(query) => ct('No asset matches', { query })}
        items={picker === 'to' ? items(reachable(pairs, from, cash), from) : items(assets, to)}
        selected={picker === 'to' ? to : from}
        onPick={(asset) => pick(picker === 'to' ? 'to' : 'from', asset)}
      />
      {deposit ? <DepositDialog route={status.deposit ?? null} test={status.test} onClose={() => setDeposit(false)} /> : null}
    </section>
  );
}

/** The price's lines, each the venue's figure or ours named as ours. */
function QuoteFacts({ quote: q, t, testid }: { quote: ConvertQuote; t: T; testid: string }) {
  const time = useTimeText();
  // On a cash convert (#11) the venue order spends the coin the partner pays in, so its prices are in that coin.
  const spent = q.cashLeg ? q.cashLeg.coin : q.from;
  const [base, quoteAsset] = q.side === 'buy' ? [q.to, spent] : [q.from, q.to];
  const legs: [string, string, string][] = q.cashLeg
    ? [
        [
          'cash-leg',
          t('Cash leg'),
          t('Cash leg value', {
            spend: displayAmount(q.spend),
            cash: q.cashLeg.cash,
            coin: displayAmount(q.cashLeg.coinSpend),
            coinAsset: q.cashLeg.coin,
            rate: displayAmount(q.cashLeg.rate),
          }),
        ],
        ['coin-leg', t('Coin leg'), t('Coin leg value', { coin: displayAmount(q.cashLeg.coinSpend), coinAsset: q.cashLeg.coin, to: q.to })],
      ]
    : [];
  const rows: [string, string, string][] = [
    ...legs,
    ['best-price', t('Best price'), t('Best price value', { base, price: displayAmount(q.bestPrice.price), quote: quoteAsset })],
    ['slippage', t('Slippage limit'), t('Slippage value', { price: displayAmount(q.limitPrice), quote: quoteAsset, bps: q.slippageBps })],
    q.side === 'buy'
      ? ['max-cost', t('Most it costs'), `${displayAmount(q.maxCost)} ${spent}`]
      : ['max-cost', t('You sell'), `${displayAmount(q.size)} ${q.from}`],
    [
      'get-about',
      t('You get about'),
      q.fill.known
        ? q.side === 'buy'
          ? `${displayAmount(q.fill.amount)} ${q.to}`
          : `${displayAmount(q.fill.averagePrice === null ? '0' : formatAmount((parseAmount(q.fill.amount) * parseAmount(q.fill.averagePrice)) / 10n ** 18n))} ${q.to}`
        : t('Not known'),
    ],
    ['venue-fee', t('Venue fee'), q.venueFee.known ? `${displayAmount(q.venueFee.amount)} ${q.venueFee.asset}` : t('Not known')],
    [
      'builder-fee',
      t('Builder fee'),
      q.builderFee.kind === 'none'
        ? t('Builder none buy')
        : t('Builder sell', {
            amount: q.builderFee.amount.known ? displayAmount(q.builderFee.amount.value) : t('Not known'),
            asset: quoteAsset,
            bps: displayAmount(q.builderFee.bps),
          }),
    ],
    ['fresh-until', t('Fresh until'), time(q.freshUntil)],
  ];
  return (
    <div data-testid={testid} data-quote-id={q.quoteId}>
      <dl>
        {rows.map(([line, label, value]) => (
          <div key={line}>
            <dt>{label}</dt>
            <dd className="lt-mono" data-line={line}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="lt-hint" data-testid="cvt-no-hold">
        {t('No hold')}
      </p>
      <TestMark test={q.test} />
    </div>
  );
}

/** A cash convert's two linked steps (#11), each as its own record says: the partner's, then the wallet's order. */
function LinkedLegs({ legs, testid }: { legs: NonNullable<Conversion['legs']>; testid: string }) {
  const { t } = venueConvertCopy.useCopy();
  const cash = 'unread' in legs.cash ? null : legs.cash;
  return (
    <ol data-testid={testid}>
      <li data-leg="cash" data-state={cash?.state ?? 'unread'} data-key={cash?.legKey ?? ''}>
        {cash
          ? t(cash.state === 'delivered' ? 'Leg cash done' : 'Leg cash sending', {
              paid: displayAmount(cash.paid),
              cash: cash.cash,
              delivered: displayAmount(cash.delivered),
              coin: cash.coin,
            })
          : t('Leg cash unread')}{' '}
        {cash ? <TestMark test={cash.test} /> : null}
      </li>
      <li data-leg="venue" data-state={legs.venue?.state ?? 'not_signed'}>
        {legs.venue
          ? t('Leg venue done', {
              paid: displayAmount(legs.venue.paid.amount),
              paidAsset: legs.venue.paid.asset,
              received: displayAmount(legs.venue.received.amount),
              receivedAsset: legs.venue.received.asset,
            })
          : t('Leg venue none', { coin: cash?.coin ?? '' })}
      </li>
    </ol>
  );
}

/** The receipt of one conversion, read from the venue's own fills by its key. */
function Receipt({
  owner,
  done,
  from,
  to,
}: {
  owner: string;
  done: { actionKey: string; order: VenueOrder | null };
  from: string;
  to: string;
}) {
  const { t } = venueConvertCopy.useCopy();
  const convert = useConvertApi();
  const time = useTimeText();
  const read = usePolled((signal) => convert.history(owner, signal), `cvt-receipt:${done.actionKey}`, 2_000);
  const c = read.data?.conversions.find((x) => x.actionKey === done.actionKey) ?? null;
  if (!c || (c.fills === 0 && c.state !== 'not_filled'))
    return (
      <p role="status" data-testid="cvt-receipt-wait">
        {t('Receipt reading')}
      </p>
    );
  if (c.fills === 0)
    return (
      <p role="alert" data-testid="cvt-receipt" data-state={c.state}>
        {t('Not filled')}
      </p>
    );
  return (
    <div role="status" data-testid="cvt-receipt" data-state={c.state} data-client-id={c.venueClientOrderId ?? ''}>
      <h3>{t('Receipt title', { from, to })}</h3>
      {c.legs ? <LinkedLegs legs={c.legs} testid="cvt-receipt-legs" /> : null}
      <dl>
        <div>
          <dt>{t('Paid')}</dt>
          <dd className="lt-mono" data-line="paid">
            {displayAmount(c.paid.amount)} {c.paid.asset}
          </dd>
        </div>
        <div>
          <dt>{t('Received')}</dt>
          <dd className="lt-mono" data-line="received">
            {displayAmount(c.received.amount)} {c.received.asset}
          </dd>
        </div>
        <div>
          <dt>{t('Venue fee')}</dt>
          <dd className="lt-mono" data-line="venue-fee">
            {c.venueFee ? `${displayAmount(c.venueFee.amount)} ${c.venueFee.asset}` : t('Not known')}
          </dd>
        </div>
        <div>
          <dt>{t('Filled at')}</dt>
          <dd data-line="time">{c.filledAt ? time(c.filledAt) : '—'}</dd>
        </div>
        <div>
          <dt>{t('Venue order')}</dt>
          <dd className="lt-mono" data-line="client-id">
            {c.venueClientOrderId}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** A pair no venue market joins: a cash currency needs a partner's cash leg, which no partner offers here (#11). */
function VenueRouteCard({ from, to }: { from: string; to: string }) {
  const { t } = venueConvertCopy.useCopy();
  const { t: ct } = convertCopy.useCopy();
  const convert = useConvertApi();
  const read = usePolled((signal) => convert.route(from, to, signal), `cvt-route:${from}:${to}`, 60_000);
  const code = read.failure?.code ?? null;
  return (
    <section data-testid="cvt-card" data-mode="venue" aria-label={ct('Convert')}>
      <div data-testid="from-field">
        <p className="lt-hint">{ct('From')}</p>
        <div className="lt-toolbar">
          <CoinMark asset={from} size="sm" />
          <span>{from}</span>
        </div>
      </div>
      <div data-testid="to-field">
        <p className="lt-hint">{ct('To')}</p>
        <div className="lt-toolbar">
          <CoinMark asset={to} size="sm" />
          <span>{to}</span>
        </div>
      </div>
      {code ? (
        <div role="alert" data-testid="cvt-route-refused" data-code={code}>
          <p>
            <strong>{code === 'trade.convert_cash_not_offered' ? t('Cash title') : t('Unlisted title')}.</strong>{' '}
            {code === 'trade.convert_cash_not_offered' ? t('Cash body', { from, to }) : t('Unlisted body', { from, to })}
          </p>
        </div>
      ) : null}
      <Button tone="primary" size="lg" block disabled>
        {t('Get a price')}
      </Button>
      <div className="lt-actions">
        <a className="lt-link" href="/trade/convert" data-testid="cvt-route-other">
          {t('Choose other coins')}
        </a>
      </div>
    </section>
  );
}

/** Recent conversions: only accepted ones, each with what the venue's fills took and gave, and when. */
function VenueRecent({ owner, test }: { owner: string; test: boolean }) {
  const { t } = venueConvertCopy.useCopy();
  const convert = useConvertApi();
  const time = useTimeText();
  const read = usePolled((signal) => convert.history(owner, signal), `cvt-recent:${owner}`, POLL_MS);
  const rows: readonly Conversion[] | null = read.data?.conversions ?? null;
  return (
    <section data-testid="cvt-recent" aria-labelledby="cvt-recent-title">
      <h2 id="cvt-recent-title">
        {t('Recent conversions')} <TestMark test={test} />
      </h2>
      {rows === null ? (
        read.failure ? (
          <ReadFailed title={t('Recent unread')} onRetry={read.reload} />
        ) : null
      ) : rows.length === 0 ? (
        <EmptyState title={t('Recent empty title')} body={t('Recent empty body')} data-kind="empty" />
      ) : (
        <table className="lt-table">
          <caption className="lt-sr">{t('Recent conversions')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('Kind')}</th>
              <th scope="col">{t('You paid')}</th>
              <th scope="col">{t('You received')}</th>
              <th scope="col">{t('Time')}</th>
              <th scope="col">{t('Status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.actionKey}
                data-testid="cvt-recent-row"
                data-key={c.actionKey}
                data-client-id={c.venueClientOrderId ?? ''}
                data-state={c.state}
              >
                <td>
                  {c.legs ? t('Linked kind') : c.kind === 'limit' ? t('Limit') : t('Instant')}
                  {c.legs ? <LinkedLegs legs={c.legs} testid="cvt-recent-legs" /> : null}
                </td>
                <td className="lt-mono" data-cell="paid">
                  {displayAmount(c.paid.amount)} {c.paid.asset}
                </td>
                <td className="lt-mono" data-cell="received">
                  {displayAmount(c.received.amount)} {c.received.asset}
                </td>
                <td data-cell="time">{c.filledAt ? time(c.filledAt) : time(c.acceptedAt)}</td>
                <td data-cell="state">{t(`state_${c.state}` as 'state_filled')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
