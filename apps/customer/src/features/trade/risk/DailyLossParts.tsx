import { useCallback, useState } from 'react';
import { Button, Checkbox, Field, Segmented } from '@intafaced/ui/lit';
import { usePreferences } from '../../../shared/preferences';
import { displayAmount } from '../../../shared/money';
import { Section, Waiting } from '../../more';
import {
  advisoryReached,
  useDailyLoss,
  useSaveDailyLoss,
  type DailyLossMode,
  type DailyLossTerms,
  type DailyLossView,
} from './daily-loss-source';
import { dailyLossCopy } from './daily-loss-copy';

type T = ReturnType<typeof dailyLossCopy.useCopy>['t'];
const LIMIT_RE = /^[0-9]+(\.[0-9]+)?$/;

/** A time in the person's chosen zone (the device's own clock unless they picked one, which is then named). */
function useWhen(): (iso: string) => string {
  const { timeZone } = usePreferences();
  return useCallback(
    (iso: string) => {
      try {
        const zone = timeZone === 'UTC' ? 'UTC' : timeZone === 'UTC+8' ? 'Etc/GMT-8' : undefined;
        const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
        return zone ? `${text} ${timeZone}` : text;
      } catch {
        return iso;
      }
    },
    [timeZone],
  );
}

const amount = (v: string) => displayAmount(v);

function termsText(t: T, terms: DailyLossTerms, asset: string) {
  return t(terms.mode === 'advisory' ? 'termsAdvisory' : 'termsBlocking', { limit: amount(terms.limit), asset });
}

/** The Risk rules room's daily loss limit: its state, today's loss, a loosening waiting, and the form that changes it. */
export function DailyLossRule({ owner }: { owner: string }) {
  const { t } = dailyLossCopy.useCopy();
  const view = useDailyLoss(owner);
  if (view.status === 'loading' || view.status === 'empty')
    return (
      <Section title={t('heading')}>
        <Waiting label={t('checking')} />
      </Section>
    );
  if (view.status !== 'ready')
    return (
      <Section title={t('heading')}>
        <p role="alert" data-testid="daily-loss-unread">
          {t('unread')}
        </p>
      </Section>
    );
  return <Rule owner={owner} view={view.data} />;
}

function Rule({ owner, view }: { owner: string; view: DailyLossView }) {
  const { t } = dailyLossCopy.useCopy();
  const when = useWhen();
  const save = useSaveDailyLoss(owner);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<{ text: string; failed: boolean } | null>(null);
  const active = view.active;
  const asset = view.asset;
  const venue = view.venue.name;
  const today = view.today;

  async function apply(change: Parameters<typeof save>[0]) {
    const answer = await save(change);
    if (!answer.ok) return setSaved({ text: t('saveFailed', { detail: answer.message }), failed: true });
    const after = answer.data;
    setEditing(false);
    setSaved(
      after.pending
        ? { text: t('savedWaits', { time: when(after.pending.effectiveAt) }), failed: false }
        : { text: t('savedNow'), failed: false },
    );
  }

  return (
    <Section title={t('heading')}>
      <div className="lt-stack" data-testid="daily-loss">
        <p className="lt-hint">{t('intro')}</p>
        <p className="lt-strong" data-testid="daily-loss-state" data-mode={active?.mode ?? 'off'} data-limit={active?.limit ?? ''}>
          {active === null ? t('off') : t(active.mode === 'advisory' ? 'onAdvisory' : 'onBlocking', { limit: amount(active.limit), asset })}
        </p>
        {today.loss === null ? (
          <p role="alert" data-testid="daily-loss-today" data-loss="">
            {t('todayUnread', { venue })}
          </p>
        ) : (
          <p data-testid="daily-loss-today" data-loss={today.loss} data-as-of={today.asOf ?? ''}>
            {active
              ? t('today', { venue, loss: amount(today.loss), asset, limit: amount(active.limit) })
              : t('todayOff', { venue, loss: amount(today.loss), asset })}{' '}
            {today.asOf ? t('todayAsOf', { time: when(today.asOf) }) : null}
          </p>
        )}
        {active && today.reached && today.loss !== null ? (
          <p role="status" data-testid="daily-loss-reached">
            {t('reached', { loss: amount(today.loss), asset, limit: amount(active.limit) })}
          </p>
        ) : null}
        <p className="lt-hint" data-testid="daily-loss-reset" data-resets-at={today.resetsAt}>
          {t('resets', { time: when(today.resetsAt) })}
        </p>
        {view.pending ? (
          <div className="lt-callout lt-stack-tight" data-testid="daily-loss-pending" data-effective-at={view.pending.effectiveAt}>
            <h3 className="lt-strong">{t('pendingHeading')}</h3>
            <p>
              {view.pending.terms
                ? t('pendingTerms', { terms: termsText(t, view.pending.terms, asset), time: when(view.pending.effectiveAt) })
                : t('pendingOff', { time: when(view.pending.effectiveAt) })}
            </p>
            {active ? <p>{t('pendingUntil', { terms: termsText(t, active, asset) })}</p> : null}
          </div>
        ) : null}
        {editing || active !== null ? (
          <RuleForm
            key={`${active?.mode ?? 'off'}:${active?.limit ?? ''}`}
            initial={active}
            asset={asset}
            on={active !== null}
            onSave={(mode, limit) => apply({ kind: 'set', mode, limit })}
            onOff={() => apply({ kind: 'off' })}
            onCancel={active === null ? () => setEditing(false) : null}
          />
        ) : (
          <div className="lt-row">
            <Button tone="primary" onClick={() => setEditing(true)}>
              {t('turnOn')}
            </Button>
          </div>
        )}
        {saved ? (
          <p role={saved.failed ? 'alert' : 'status'} data-testid="daily-loss-saved">
            {saved.text}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function RuleForm({
  initial,
  asset,
  on,
  onSave,
  onOff,
  onCancel,
}: {
  initial: DailyLossTerms | null;
  asset: string;
  on: boolean;
  onSave: (mode: DailyLossMode, limit: string) => Promise<void>;
  onOff: () => Promise<void>;
  onCancel: (() => void) | null;
}) {
  const { t } = dailyLossCopy.useCopy();
  const [mode, setMode] = useState<DailyLossMode>(initial?.mode ?? 'advisory');
  const [limit, setLimit] = useState(initial?.limit ?? '');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    await task();
    setBusy(false);
  }
  function submit() {
    const v = limit.trim();
    if (!LIMIT_RE.test(v) || /^0+(\.0+)?$/.test(v)) return setInvalid(true);
    setInvalid(false);
    void run(() => onSave(mode, v));
  }
  return (
    <form
      className="lt-stack"
      aria-label={t('heading')}
      data-testid="daily-loss-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Segmented
        label={t('modeLabel')}
        options={[
          { value: 'advisory', label: t('warnMe') },
          { value: 'blocking', label: t('stopNew') },
        ]}
        value={mode}
        onChange={setMode}
        marks={{ 'data-testid': 'daily-loss-mode' }}
      />
      <p className="lt-hint">{mode === 'advisory' ? t('warnMeHint') : t('stopNewHint')}</p>
      <Field
        label={t('limitLabel', { asset })}
        inputMode="decimal"
        value={limit}
        onChange={(event) => setLimit(event.currentTarget.value)}
        {...(invalid ? { error: t('limitInvalid') } : {})}
      />
      <div className="lt-row">
        <Button tone="primary" type="submit" disabled={busy}>
          {busy ? t('saving') : t('save')}
        </Button>
        {on ? (
          <Button tone="quiet" disabled={busy} onClick={() => void run(onOff)}>
            {t('turnOff')}
          </Button>
        ) : null}
        {onCancel ? (
          <Button tone="quiet" disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The desk's line once today's loss has reached the limit in force (or could not be read with one on); nothing while off. */
export function DeskDailyLoss({ view }: { view: DailyLossView | null }) {
  const { t } = dailyLossCopy.useCopy();
  const when = useWhen();
  const active = view?.active ?? null;
  if (!view || !active) return null;
  const asset = view.asset;
  const limit = amount(active.limit);
  const loss = view.today.loss;
  if (loss === null)
    return (
      <p role="alert" className="lt-callout" data-testid="daily-loss-desk" data-state="unread">
        {t('deskUnread', { limit, asset, venue: view.venue.name })} <a href="/trade/risk/rules">{t('openRules')}</a>
      </p>
    );
  if (!view.today.reached) return null;
  return (
    <p
      role="alert"
      className="lt-callout"
      data-testid="daily-loss-desk"
      data-state={active.mode}
      data-loss={loss}
      data-limit={active.limit}
      data-resets-at={view.today.resetsAt}
    >
      {active.mode === 'advisory'
        ? t('deskAdvisory', { loss: amount(loss), asset, limit })
        : t('deskBlocking', { loss: amount(loss), asset, limit, time: when(view.today.resetsAt) })}{' '}
      <a href="/trade/risk/rules">{t('openRules')}</a>
    </p>
  );
}

/** The review's confirm for an opening order past an advisory limit: names the limit, and must be ticked to send. */
export function DailyLossConfirm({
  view,
  accepted,
  onAccept,
}: {
  view: DailyLossView;
  accepted: boolean;
  onAccept: (checked: boolean) => void;
}) {
  const { t } = dailyLossCopy.useCopy();
  const terms = advisoryReached(view);
  if (!terms) return null;
  const limit = amount(terms.limit);
  const asset = view.asset;
  return (
    <section
      aria-label={t('confirmHeading')}
      data-testid="daily-loss-confirm"
      data-limit={terms.limit}
      className="lt-callout lt-stack-tight"
    >
      <h3 className="lt-strong">{t('confirmHeading')}</h3>
      <p>
        {view.today.loss === null
          ? t('confirmUnread', { limit, asset })
          : t('confirmBody', { loss: amount(view.today.loss), asset, limit })}
      </p>
      <Checkbox checked={accepted} onCheckedChange={onAccept}>
        {t('confirmAccept', { limit, asset })}
      </Checkbox>
    </section>
  );
}

/** What the review shows when svc-trade refused an opening order on a blocking limit: the limit, today's loss and the reset. */
export function DailyLossRefused({ view }: { view: DailyLossView | null }) {
  const { t } = dailyLossCopy.useCopy();
  const when = useWhen();
  if (!view || !view.active) return null;
  return (
    <section
      role="alert"
      aria-label={t('refusedHeading')}
      data-testid="daily-loss-refused"
      data-resets-at={view.today.resetsAt}
      className="lt-callout lt-stack-tight"
    >
      <h3 className="lt-strong">{t('refusedHeading')}</h3>
      <p>
        {t('refusedBody', {
          loss: view.today.loss === null ? '—' : amount(view.today.loss),
          asset: view.asset,
          limit: amount(view.active.limit),
          time: when(view.today.resetsAt),
        })}
      </p>
    </section>
  );
}
