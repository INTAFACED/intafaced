import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { DexRecurringPlan } from '@intafaced/contracts/protocol-dex-orders';
import { Button, Dialog, EmptyState, Field, Panel } from '../../../shared/ui';
import { currentPreferences, usePreferences } from '../../../shared/preferences';
import { stamp } from '../../../screens/money/time';
import type { OrdersContext, Refusal } from './OrdersRoom';
import type { RecurringInput } from './orders-api';
import { recurringCopy, type RecurringTranslate } from './recurring-copy';

type Options = {
  tokens: { address: string; symbol: string; decimals: number }[];
  intervals: RecurringInput['every'][];
  retryWindowSeconds: number;
  price: string | null;
  priceUnit: string;
  idleYield: { available: boolean; reason: string };
};

const POLL_MS = 2_000;

function words(t: RecurringTranslate, r: Refusal): string {
  if (!r.code) return r.reason === 'unreachable' || r.reason === 'uncertain' ? t('unreachable') : t('refusedOther');
  return t('refused', { words: r.message || t('refusedOther'), code: r.code });
}

/** "20 minutes": a whole number of the largest unit that divides it. */
function windowText(t: RecurringTranslate, seconds: number): string {
  if (seconds % 3_600 === 0) return t('hours', { n: String(seconds / 3_600) });
  if (seconds % 60 === 0) return t('minutes', { n: String(seconds / 60) });
  return t('seconds', { n: String(seconds) });
}

/**
 * The "Recurring buy" tab (D-limit-dca-05): the form to start a plan, and each plan with its rounds, progress, next fill
 * and log. Starting signs the order session (once per tab) and sends two calls from the wallet: allow the vault the whole
 * amount, then start the plan. No round asks the wallet again; cancelling is one call from the wallet.
 */
export function RecurringPanel({ ctx }: { ctx: OrdersContext }) {
  const { language } = usePreferences();
  const { t } = recurringCopy.forLocale(language);
  const { api, address, gated, send, revision, changed } = ctx;
  const [options, setOptions] = useState<Options | null>(null);
  const [plans, setPlans] = useState<DexRecurringPlan[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [fresh, setFresh] = useState(true);

  useEffect(() => {
    void api.recurring.options(address).then((r) => (r.ok ? setOptions(r.data as Options) : setProblem(words(t, r))));
  }, [api, address, t, revision]);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    // The first read when the page opens asks the service to read the chain by each plan's own id first.
    void api.recurring.list(address, fresh).then((r) => {
      if (!live) return;
      if (r.ok) {
        setPlans(r.data.plans);
        setFresh(false);
      } else setProblem(words(t, r));
    });
    return () => {
      live = false;
    };
    // `fresh` is read once per open; a later read is a plain one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, address, t, tick, revision]);

  return (
    <>
      <Panel title={t('formTitle')}>
        <p className="muted">{t('intro')}</p>
        {options ? <RecurringForm ctx={ctx} options={options} t={t} /> : problem && <p role="alert">{problem}</p>}
      </Panel>
      <section aria-label={t('tab')}>
        {plans === null ? (
          <p className="muted">{t('loading')}</p>
        ) : plans.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} t={t} wallet={address} api={api} gated={gated} send={send} changed={changed} />
          ))
        )}
      </section>
    </>
  );
}

function RecurringForm({ ctx, options, t }: { ctx: OrdersContext; options: Options; t: RecurringTranslate }) {
  const { api, gated, send, changed, ensureSession } = ctx;
  const [spend, setSpend] = useState(options.tokens[0]?.address ?? '');
  const [buy, setBuy] = useState(options.tokens[1]?.address ?? '');
  const [amount, setAmount] = useState('');
  const [rounds, setRounds] = useState('');
  const [every, setEvery] = useState<RecurringInput['every']>(options.intervals[0] ?? 'hour');
  const [low, setLow] = useState('');
  const [high, setHigh] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const yieldHelp = useId();
  const spendToken = options.tokens.find((x) => x.address === spend);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDone(null);
    setBusy(true);
    try {
      const session = await ensureSession();
      if (typeof session === 'string') return setProblem(session);
      const failed = await gated(async () => {
        const prepared = await api.recurring.prepare(session.accessToken, {
          spend,
          buy,
          amountEachRound: amount.trim(),
          rounds: Number(rounds.trim()),
          every,
          ...(low.trim() ? { lowestPrice: low.trim() } : {}),
          ...(high.trim() ? { highestPrice: high.trim() } : {}),
        });
        if (!prepared.ok) return setProblem(words(t, prepared));
        const sent = await send({
          title: t('startSteps'),
          steps: prepared.data.calls.map((c) => ({ label: c.label, request: { kind: 'transaction', to: c.to, data: c.data } })),
        });
        if (sent) return setProblem(sent);
        setDone(t('started', { total: prepared.data.total, symbol: prepared.data.symbol }));
      });
      if (failed) setProblem(failed);
    } finally {
      setBusy(false);
      changed();
    }
  };

  const unit = options.priceUnit;
  return (
    <form aria-label={t('formTitle')} onSubmit={(e) => void start(e)}>
      <label className="field">
        <span>{t('spend')}</span>
        <select aria-label={t('spend')} value={spend} onChange={(e) => setSpend(e.target.value)}>
          {options.tokens.map((x) => (
            <option key={x.address} value={x.address}>
              {x.symbol}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('buy')}</span>
        <select aria-label={t('buy')} value={buy} onChange={(e) => setBuy(e.target.value)}>
          {options.tokens.map((x) => (
            <option key={x.address} value={x.address}>
              {x.symbol}
            </option>
          ))}
        </select>
      </label>
      <p className="numeric" data-testid="current-price">
        {options.price === null ? t('priceUnknown') : t('price', { price: options.price, unit })}
      </p>
      <Field
        label={t('amount', { symbol: spendToken?.symbol ?? '' })}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Field label={t('rounds')} inputMode="numeric" value={rounds} onChange={(e) => setRounds(e.target.value)} />
      <label className="field">
        <span>{t('every')}</span>
        <select aria-label={t('every')} value={every} onChange={(e) => setEvery(e.target.value as RecurringInput['every'])}>
          {options.intervals.map((i) => (
            <option key={i} value={i}>
              {t(`every_${i}` as 'every_hour')}
            </option>
          ))}
        </select>
      </label>
      <Field label={t('lowest', { unit })} inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} hint={t('bandHint')} />
      <Field label={t('highest', { unit })} inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value)} />
      <p className="muted">{t('retryWindow', { window: windowText(t, options.retryWindowSeconds) })}</p>
      <label className="field">
        <button
          type="button"
          role="switch"
          aria-checked={false}
          aria-label={t('idleYield')}
          aria-describedby={yieldHelp}
          disabled={!options.idleYield.available}
        >
          {t('idleYield')}
        </button>
        <small id={yieldHelp}>{options.idleYield.reason}</small>
      </label>
      <Button type="submit" disabled={busy}>
        {busy ? t('starting') : t('start')}
      </Button>
      {done && <p role="status">{done}</p>}
      {problem && <p role="alert">{problem}</p>}
    </form>
  );
}

function PlanCard({
  plan,
  t,
  wallet,
  api,
  gated,
  send,
  changed,
}: {
  plan: DexRecurringPlan;
  t: RecurringTranslate;
  wallet: string;
  api: OrdersContext['api'];
  gated: OrdersContext['gated'];
  send: OrdersContext['send'];
  changed: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const zone = currentPreferences().timeZone;
  const percent = plan.rounds === 0 ? 0 : Math.round((plan.filled / plan.rounds) * 100);
  const unit = `${plan.spend.symbol} per ${plan.buy.symbol}`;

  const refuse = useCallback(
    async (kind: 'edit' | 'pause') => {
      setProblem(null);
      const r = await api.recurring[kind](wallet, plan.id);
      setProblem(r.ok ? t('refusedOther') : r.message || t('refusedOther'));
    },
    [api, wallet, plan.id, t],
  );

  const cancel = async () => {
    setConfirming(false);
    setProblem(null);
    const r = await api.recurring.cancel(wallet, plan.id);
    if (!r.ok) return setProblem(words(t, r));
    const failed = await gated(async () => {
      const sent = await send({
        title: t('cancelSteps'),
        steps: r.data.calls.map((c) => ({ label: c.label, request: { kind: 'transaction', to: c.to, data: c.data } })),
      });
      if (sent) return setProblem(sent);
      setStatus(t('cancelled', { refund: r.data.refund, symbol: r.data.symbol }));
    });
    if (failed) setProblem(failed);
    changed();
  };

  const shownStatus =
    status ??
    (plan.state === 'cancelled' && plan.refund
      ? t('cancelled', { refund: plan.refund, symbol: plan.spend.symbol })
      : plan.state === 'done'
        ? t('done')
        : null);
  return (
    <article
      className="panel"
      aria-label={t('planTitle', {
        amount: plan.amountEachRound,
        spend: plan.spend.symbol,
        buy: plan.buy.symbol,
        every: t(`every_${plan.every}` as 'every_hour'),
      })}
    >
      <h3>
        {t('planTitle', {
          amount: plan.amountEachRound,
          spend: plan.spend.symbol,
          buy: plan.buy.symbol,
          every: t(`every_${plan.every}` as 'every_hour'),
        })}
      </h3>
      <dl className="kv">
        <dt>{t('orderHash')}</dt>
        <dd className="numeric" data-testid="order-hash">
          {plan.id}
        </dd>
        <dt>{t('progressLabel')}</dt>
        <dd>
          <progress
            aria-label={t('progressLabel')}
            max={100}
            value={percent}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          />{' '}
          {t('progress', { filled: String(plan.filled), rounds: String(plan.rounds), percent: String(percent) })}
        </dd>
        <dt>{t('nextFill')}</dt>
        <dd data-testid="next-fill">
          {plan.nextFill ? <time dateTime={plan.nextFill}>{stamp(plan.nextFill, zone)}</time> : t('nextNone')}
        </dd>
        <dt>{t('bandLabel')}</dt>
        <dd>
          {plan.lowestPrice || plan.highestPrice
            ? t('band', { low: plan.lowestPrice ?? '0', high: plan.highestPrice ?? '∞', unit })
            : t('bandNone')}
        </dd>
        <dd data-testid="retry-window">{t('retryWindow', { window: windowText(t, plan.retryWindowSeconds) })}</dd>
      </dl>
      <table aria-label={t('roundsTable')}>
        <thead>
          <tr>
            <th scope="col">{t('colRound')}</th>
            <th scope="col">{t('colDue')}</th>
            <th scope="col">{t('colState')}</th>
            <th scope="col">{t('colOut')}</th>
            <th scope="col">{t('colTx')}</th>
          </tr>
        </thead>
        <tbody>
          {plan.roundsList.map((r) => (
            <tr key={r.n}>
              <td>{t('round', { n: String(r.n) })}</td>
              <td>
                <time dateTime={r.due}>{stamp(r.due, zone)}</time>
              </td>
              <td>{t(`state_${r.state}` as 'state_filled')}</td>
              <td className="numeric">{r.amountOut ? `${r.amountOut} ${plan.buy.symbol}` : ''}</td>
              <td>{r.txHash && <a href={`/chain/tx/${r.txHash}`}>{t('tx')}</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{t('log')}</h4>
      <ul aria-label={t('log')}>{plan.log.length === 0 ? <li>{t('logEmpty')}</li> : plan.log.map((l, i) => <li key={i}>{l.text}</li>)}</ul>
      {plan.state === 'open' && (
        <div className="actions">
          <Button variant="ghost" onClick={() => void refuse('edit')}>
            {t('edit')}
          </Button>
          <Button variant="ghost" onClick={() => void refuse('pause')}>
            {t('pause')}
          </Button>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t('cancel')}
          </Button>
        </div>
      )}
      {shownStatus && <p role="status">{shownStatus}</p>}
      {problem && <p role="alert">{problem}</p>}
      {confirming && (
        <Dialog title={t('cancelTitle')} onClose={() => setConfirming(false)}>
          <p>{t('cancelCopy')}</p>
          <Button variant="danger" onClick={() => void cancel()}>
            {t('cancelConfirm')}
          </Button>
        </Dialog>
      )}
    </article>
  );
}
