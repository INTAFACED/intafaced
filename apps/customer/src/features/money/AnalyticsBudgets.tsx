import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Field } from '../../shared/ui';
import { defineCopy } from '../../shared/i18n';
import { useSession } from '../session/session';
import { useBankRead } from './components';
import { bankWrites } from './contracts';
import { DepthPanel } from './DepthParts';
import './bank-depth.css';

/** Words for budgets and month comparison in Analytics (BK-acct-08, J-bank-16 #4, #5). */
export const budgetsCopy = defineCopy('analytics-budgets', {
  budgetsTitle: 'Budgets',
  budgetsLead:
    'A monthly target for a kind of spending, and the share of it at which you want an alert. Spend is read from your ledger lines.',
  category: 'Category',
  target: 'Monthly target ({asset})',
  alertAt: 'Alert at (percent of target)',
  save: 'Save budget',
  saving: 'Saving…',
  none: 'No budget set yet.',
  progress: '{category}: {spent} of {target} {asset} spent this month · {percent}%',
  alert: 'You have used {percent}% of your {category} budget this month.',
  alertSeen: 'Alert shown this month on {date}.',
  moneyIn: 'Money in this month: {amount} {asset}. Deposits are money in, not spending, so they count toward no budget.',
  left: 'Left to spend this month: {left} {asset} of {target} {asset}',
  leftUnset: 'Set a budget to see what is left to spend.',
  compareTitle: 'Compare months',
  compareLead: 'Each kind of spending per month side by side. A month with no movement shows 0.',
  firstMonth: 'First month',
  secondMonth: 'Second month',
  compareTable: 'Spend by category per month',
  change: 'Change',
  totalOut: 'Total out',
  totalIn: 'Total in',
  failed: '{message}',
  transfers: 'Transfers',
  trading: 'Trading',
  p2p: 'P2P',
  fees: 'Fees',
  withdrawals: 'Withdrawals',
  earn: 'Earn',
  rewards: 'Rewards',
  other: 'Other',
});

const CATEGORIES = ['transfers', 'trading', 'p2p', 'fees', 'withdrawals', 'earn', 'rewards', 'other'] as const;
type Category = (typeof CATEGORIES)[number];
const monthOf = (at: Date) => at.toISOString().slice(0, 7);
const previousMonth = (at: Date) => monthOf(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)));
const percentOf = (bps: number) => (bps / 100).toString();
const dateOf = (iso: string) =>
  new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

/** Budgets with this month's progress and the alert once per month, money in apart from spending, and left to spend. */
export function AnalyticsBudgets({ assetId }: { assetId: string }) {
  const { t } = budgetsCopy.useCopy();
  const { api } = useSession();
  const name = (c: string) => (CATEGORIES.includes(c as Category) ? t(c as Category) : c);
  const budgets = useBankRead('analytics.budgets', { assetId }, Boolean(assetId));
  const left = useBankRead('analytics.leftToSpend', { assetId }, Boolean(assetId));
  const month = useMemo(() => {
    const now = new Date();
    return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: now.toISOString() };
  }, []);
  const spend = useBankRead('analytics.spend', { assetId, ...month }, Boolean(assetId));
  const [category, setCategory] = useState<Category>('transfers');
  const [target, setTarget] = useState('');
  const [alertAt, setAlertAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Alerts this page has shown in this visit: the bank records each once, and reads it back as seen from then on.
  const [shownNow, setShownNow] = useState<Record<string, string>>({});
  const told = useRef(new Set<string>());

  const rows = budgets.resource.status === 'ready' ? budgets.resource.data : [];
  useEffect(() => {
    for (const b of rows) {
      if (b.alert !== 'new' || told.current.has(`${b.category}:${b.period}`)) continue;
      told.current.add(`${b.category}:${b.period}`);
      setShownNow((now) => ({ ...now, [b.category]: percentOf(b.progressBps) }));
      void api.mutate('bank', 'analytics.budgetAlertShown', { assetId, category: b.category }, bankWrites['analytics.budgetAlertShown']);
    }
  }, [rows, api, assetId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const share = Math.round(Number(alertAt) * 100);
    setBusy(true);
    setFailure(null);
    const result = await api.mutate(
      'bank',
      'analytics.setBudget',
      { assetId, category, target, alertBps: share },
      bankWrites['analytics.setBudget'],
    );
    setBusy(false);
    if (!result.ok) return setFailure(`${result.message}${result.code ? ` (${result.code})` : ''}`);
    budgets.reload();
    left.reload();
  }

  return (
    <DepthPanel title={t('budgetsTitle')} lead={t('budgetsLead')}>
      <div className="form-stack" data-testid="analytics-budgets">
        <form className="form-stack" onSubmit={save} noValidate>
          <label className="field">
            <span>{t('category')}</span>
            <select value={category} onChange={(event) => setCategory(event.target.value as Category)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(c)}
                </option>
              ))}
            </select>
          </label>
          <Field
            label={t('target', { asset: assetId })}
            inputMode="decimal"
            value={target}
            onChange={(event) => setTarget(event.target.value.trim())}
          />
          <Field label={t('alertAt')} inputMode="decimal" value={alertAt} onChange={(event) => setAlertAt(event.target.value.trim())} />
          <Button type="submit" disabled={busy || !assetId}>
            {busy ? t('saving') : t('save')}
          </Button>
          {failure && (
            <p role="alert" className="error-text">
              {failure}
            </p>
          )}
        </form>
        {rows.length === 0 ? (
          <p className="money-caption">{t('none')}</p>
        ) : (
          <ul className="form-stack">
            {rows.map((b) => {
              const percent = percentOf(b.progressBps);
              return (
                <li key={b.category} data-testid={`budget-${b.category}`} data-progress-bps={b.progressBps} data-alert={b.alert ?? ''}>
                  <p>{t('progress', { category: name(b.category), spent: b.spent, target: b.target, asset: assetId, percent })}</p>
                  <progress max={10_000} value={Math.min(b.progressBps, 10_000)} aria-label={name(b.category)} />
                  {shownNow[b.category] !== undefined ? (
                    <p role="alert" data-testid="budget-alert">
                      {t('alert', { percent, category: name(b.category) })}
                    </p>
                  ) : b.alert === 'seen' && b.alertShownAt ? (
                    <p className="money-caption" data-testid="budget-alert-seen">
                      {t('alertSeen', { date: dateOf(b.alertShownAt) })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {spend.resource.status === 'ready' && (
          <p className="money-caption" data-testid="analytics-money-in" data-inflow={spend.resource.data.totalInflow}>
            {t('moneyIn', { amount: spend.resource.data.totalInflow, asset: assetId })}
          </p>
        )}
        {left.resource.status === 'ready' ? (
          <p data-testid="left-to-spend" data-left={left.resource.data.left}>
            {t('left', { left: left.resource.data.left, target: left.resource.data.target, asset: assetId })}
          </p>
        ) : left.resource.status === 'failed' ? (
          <p className="money-caption" data-testid="left-to-spend" data-code={left.resource.failure.code ?? ''}>
            {left.resource.failure.code === 'bank.budget_unset' ? t('leftUnset') : t('failed', { message: left.resource.failure.message })}
          </p>
        ) : null}
      </div>
    </DepthPanel>
  );
}

/** Two months side by side by category, with each category's change, from the bank's ledger fold. */
export function AnalyticsCompare({ assetId }: { assetId: string }) {
  const { t } = budgetsCopy.useCopy();
  const name = (c: string) => (CATEGORIES.includes(c as Category) ? t(c as Category) : c);
  const [first, setFirst] = useState(() => previousMonth(new Date()));
  const [second, setSecond] = useState(() => monthOf(new Date()));
  const valid = /^\d{4}-\d{2}$/.test(first) && /^\d{4}-\d{2}$/.test(second) && first !== second;
  const compare = useBankRead('analytics.compare', { assetId, months: [first, second] }, Boolean(assetId) && valid);
  return (
    <DepthPanel title={t('compareTitle')} lead={t('compareLead')}>
      <div className="form-stack" data-testid="analytics-compare">
        <Field label={t('firstMonth')} type="month" value={first} onChange={(event) => setFirst(event.target.value)} />
        <Field label={t('secondMonth')} type="month" value={second} onChange={(event) => setSecond(event.target.value)} />
        {compare.resource.status === 'failed' && valid && (
          <p role="alert" className="error-text" data-code={compare.resource.failure.code ?? ''}>
            {compare.resource.failure.message}
          </p>
        )}
        {compare.resource.status === 'ready' && (
          <table aria-label={t('compareTable')}>
            <thead>
              <tr>
                <th scope="col">{t('category')}</th>
                {compare.resource.data.months.map((m) => (
                  <th key={m} scope="col">
                    {m}
                  </th>
                ))}
                <th scope="col">{t('change')}</th>
              </tr>
            </thead>
            <tbody>
              {compare.resource.data.categories.map((row) => (
                <tr key={row.category} data-category={row.category}>
                  <th scope="row">{name(row.category)}</th>
                  {row.byMonth.map((v, i) => (
                    <td key={compare.resource.status === 'ready' ? compare.resource.data.months[i] : i}>{v}</td>
                  ))}
                  <td>{row.change}</td>
                </tr>
              ))}
              <tr data-category="total-out">
                <th scope="row">{t('totalOut')}</th>
                {compare.resource.data.totalOutflow.map((v, i) => (
                  <td key={i}>{v}</td>
                ))}
                <td />
              </tr>
              <tr data-category="total-in">
                <th scope="row">{t('totalIn')}</th>
                {compare.resource.data.totalInflow.map((v, i) => (
                  <td key={i}>{v}</td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </DepthPanel>
  );
}
