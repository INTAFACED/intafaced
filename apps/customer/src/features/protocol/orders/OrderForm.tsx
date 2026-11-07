import { useRef, useState, type FormEvent } from 'react';
import { Button, Field, Panel } from '../../../shared/ui';
import { useWallet } from '../wallet/WalletProvider';
import type { PlaceInput } from './orders-api';
import type { OrdersContext } from './OrdersRoom';
import { refusalWords } from './OrdersRoom';

type Kind = PlaceInput['kind'];
const KINDS: readonly Kind[] = ['sell_above', 'sell_below', 'buy_above', 'buy_below', 'take_profit_and_stop', 'bracket', 'trailing_stop'];
const PRICE_KINDS = new Set<Kind>(['sell_above', 'sell_below', 'buy_above', 'buy_below']);
/** Suggested lifetimes, shown as buttons; none is chosen for the person (D-limit-dca-02). */
const LIFETIMES = ['1', '24', '168'] as const;
const BASE = 'TEST A';
const QUOTE = 'TEST B';

/**
 * The new-order form (D-limit-dca-02, -03). The checks a person can see before anything is sent run here first (a price
 * order with no expiry, a take-profit on the wrong side of its stop); the service checks everything again. Placing signs
 * each order of the request in the wallet (one for a price or trailing order, two for a take-profit and stop pair, three
 * for a bracket), then the service stores them; nothing moves until a fill.
 */
export function OrderForm({ ctx }: { ctx: OrdersContext }) {
  const { api, session, t, gated, changed } = ctx;
  const wallet = useWallet();
  const sign = useRef(wallet.sign);
  sign.current = wallet.sign;
  const [kind, setKind] = useState<Kind>('sell_above');
  const [side, setSide] = useState<'buy' | 'sell'>('sell');
  const [amount, setAmount] = useState('');
  const [trigger, setTrigger] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [stop, setStop] = useState('');
  const [expiry, setExpiry] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chooseKind = (next: Kind) => {
    setKind(next);
    if (next.startsWith('sell_')) setSide('sell');
    if (next.startsWith('buy_') || next === 'bracket') setSide('buy');
  };
  const chooseSide = (next: 'buy' | 'sell') => {
    setSide(next);
    // A price order's type names its side: flipping the side flips the type with it.
    if (PRICE_KINDS.has(kind)) setKind(`${next}_${kind.split('_')[1]}` as Kind);
  };

  const place = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDone(null);
    if (expiry.trim() === '') return setProblem(t('formNeedsExpiry'));
    if (kind === 'take_profit_and_stop' || kind === 'bracket') {
      const tp = Number(takeProfit);
      const sl = Number(stop);
      const sells = kind === 'bracket' || side === 'sell';
      if (Number.isFinite(tp) && Number.isFinite(sl) && sells && tp <= sl) return setProblem(t('formTpAboveStop'));
      if (Number.isFinite(tp) && Number.isFinite(sl) && !sells && tp >= sl) return setProblem(t('formTpBelowStop'));
    }
    if (!session) return setProblem(t('needSession'));
    setBusy(true);
    try {
      const failed = await gated(async () => {
        const input: PlaceInput = {
          kind,
          side,
          amount: amount.trim(),
          expiryHours: expiry.trim(),
          ...(kind === 'trailing_stop' ? { trailPercent: trigger.trim().replace(/%$/, '') } : {}),
          ...(PRICE_KINDS.has(kind) || kind === 'bracket' ? { trigger: trigger.trim() } : {}),
          ...(kind === 'take_profit_and_stop' || kind === 'bracket' ? { takeProfit: takeProfit.trim(), stop: stop.trim() } : {}),
        };
        const prepared = await api.prepare(session.accessToken, input);
        if (!prepared.ok) return setProblem(refusalWords(t, prepared));
        const signatures: string[] = [];
        for (const order of prepared.data.orders) {
          const signed = await sign.current({ kind: 'typedData', typedData: order.typedData as never });
          if (signed.status === 'rejected') return setProblem(t('walletRejected'));
          if (signed.status !== 'signed')
            return setProblem(t('walletFailed', { message: signed.status === 'failed' ? signed.message : '' }));
          signatures.push(signed.signature);
        }
        const created = await api.create(session.accessToken, prepared.data.draftId, signatures);
        if (!created.ok) return setProblem(refusalWords(t, created));
        const warning = prepared.data.warnings[0];
        setDone(
          `${t('formPlaced', { resting: prepared.data.sheet.resting })} ${prepared.data.sheet.rate}${warning ? ` ${t('formWarning', { percentage: warning.percentage })}` : ''}`,
        );
      });
      if (failed) setProblem(failed);
    } finally {
      setBusy(false);
      changed();
    }
  };

  const pricePair = { quote: QUOTE, base: BASE };
  return (
    <Panel title={t('formTitle')}>
      <form aria-label={t('formTitle')} onSubmit={(e) => void place(e)}>
        <label className="field">
          <span>{t('formType')}</span>
          <select aria-label={t('formType')} value={kind} onChange={(e) => chooseKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`type_${k}` as 'type_bracket')}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>{t('formSide')}</legend>
          {(['buy', 'sell'] as const).map((s) => (
            <label key={s}>
              <input type="radio" name="side" value={s} checked={side === s} onChange={() => chooseSide(s)} />{' '}
              {s === 'buy' ? t('formBuy') : t('formSell')}
            </label>
          ))}
        </fieldset>
        <Field label={t('formAmount', { symbol: BASE })} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        {(PRICE_KINDS.has(kind) || kind === 'bracket') && (
          <Field
            label={kind === 'bracket' ? t('formEntry', pricePair) : t('formTrigger', pricePair)}
            inputMode="decimal"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
        )}
        {kind === 'trailing_stop' && <Field label={t('formDistance')} value={trigger} onChange={(e) => setTrigger(e.target.value)} />}
        {(kind === 'take_profit_and_stop' || kind === 'bracket') && (
          <>
            <Field
              label={t('formTakeProfit', pricePair)}
              inputMode="decimal"
              value={takeProfit}
              onChange={(e) => setTakeProfit(e.target.value)}
            />
            <Field label={t('formStop', pricePair)} inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
          </>
        )}
        <Field label={t('formExpires')} inputMode="decimal" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        <div className="actions" role="group" aria-label={t('formLifetimes')}>
          {LIFETIMES.map((h) => (
            <Button key={h} variant="ghost" onClick={() => setExpiry(h)}>
              {t('formHours', { hours: h })}
            </Button>
          ))}
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? t('formPlacing') : t('formPlace')}
        </Button>
        {done && <p role="status">{done}</p>}
        {problem && <p role="alert">{problem}</p>}
      </form>
    </Panel>
  );
}
