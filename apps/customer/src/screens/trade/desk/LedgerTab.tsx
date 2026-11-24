import { useCallback, useEffect, useRef, useState } from 'react';
import type { BalanceEntry } from '../../../data/derive';
import type { LedgerEntry, StatementJob } from '../../../features/trade/trade-api';
import { usePreferences } from '../../../shared/preferences';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import { Amount, Button, StateBlock, DateInput } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { fmtAmount, refusalCopy, type Loadable } from './deps';
import { ledgerKindKey, sameAmount, sha256Hex, statementRange, sumByAsset, todayEnd } from './ledger';
import { clockMinutes, dayTime } from './time';

/** A note's classes by its tone, and a ledger change's by its direction. */
const NOTE = { pending: 'lt-note', finished: 'lt-note', failed: 'lt-note lt-note-bad' } as const;
const CHANGE = { in: 'lt-end lt-num lt-up', out: 'lt-end lt-num lt-down' } as const;

const PAGE = 50;

type Read =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: LedgerEntry[]; next: string | null; more: boolean; failed: boolean };

/**
 * Ledger history (J-cex-spot-07 #6): every change to the person's available balances, newest first, each with the
 * ledger's own reference. Once every line is read, each asset's lines are added up and set beside its available balance,
 * so the person can see the list is whole. The statement export (#5) sits in the same tab.
 */
export function LedgerTab({ balances }: { balances: Loadable<Record<string, BalanceEntry>> }) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const api = useDeskApi();
  const [read, setRead] = useState<Read>({ status: 'loading' });
  // Only the newest request may answer: a Reload makes any older page that lands later moot.
  const latest = useRef(0);
  useEffect(() => {
    const mounted = latest;
    return () => void (mounted.current += 1);
  }, []);

  const load = useCallback(
    async (after: LedgerEntry[] | null, cursor: string | null) => {
      const mine = (latest.current += 1);
      if (after) setRead({ status: 'ready', entries: after, next: cursor, more: true, failed: false });
      else setRead({ status: 'loading' });
      const result = await api.ledger({ limit: PAGE, ...(cursor ? { cursor } : {}) });
      if (latest.current !== mine) return;
      if (!result.ok) {
        // An older page that fails keeps the lines already shown, and says so.
        if (after) return setRead({ status: 'ready', entries: after, next: cursor, more: false, failed: true });
        return setRead({ status: 'error' });
      }
      setRead({
        status: 'ready',
        entries: [...(after ?? []), ...result.data.entries],
        next: result.data.nextCursor,
        more: false,
        failed: false,
      });
    },
    [api],
  );
  useEffect(() => {
    void load(null, null);
  }, [load]);

  return (
    <div className="lt-stack">
      <div className="lt-row lt-row-between">
        <Statement />
        <Button tone="secondary" size="sm" onClick={() => void load(null, null)}>
          {t('Ledger reload')}
        </Button>
      </div>
      {read.status === 'loading' ? (
        <StateBlock kind="loading" label={t('Ledger loading')} />
      ) : read.status === 'error' ? (
        <StateBlock kind="error" title={t('Ledger unreadable')} onRetry={() => void load(null, null)} retryLabel={t('Try again')} />
      ) : read.entries.length === 0 ? (
        <StateBlock kind="empty" title={t('Ledger empty')} />
      ) : (
        <>
          <div className="lt-table-scroll" tabIndex={0} role="region" aria-label={t('Ledger history')}>
            <table data-testid="dk-table" className="lt-table lt-table-dense" aria-label={t('Ledger history')}>
              <thead>
                <tr>
                  <th>{t('Time')}</th>
                  <th>{t('Asset')}</th>
                  <th className="lt-end">{t('Ledger change')}</th>
                  <th>{t('Ledger kind')}</th>
                  <th>{t('Ledger reference')}</th>
                </tr>
              </thead>
              <tbody>
                {read.entries.map((e) => (
                  <tr key={e.id} data-entry={e.id}>
                    <td>{dayTime(e.timestamp, timeZone)}</td>
                    <td>{e.currency}</td>
                    <td className={CHANGE[e.direction]}>
                      {e.direction === 'in' ? '+' : '−'}
                      <Amount value={fmtAmount(e.amount, { places: 8 })} />
                    </td>
                    <td>{t(ledgerKindKey(e))}</td>
                    <td data-testid="dk-ledger-ref" className="lt-mono" title={t('Ledger entry', { id: e.id })}>
                      {e.referenceId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {read.failed ? (
            <p data-testid="dk-note--bad" className="lt-note lt-note-bad" role="alert">
              {t('Ledger more failed')}
            </p>
          ) : null}
          {read.next ? (
            <Button busy={read.more} tone="secondary" size="sm" onClick={() => void load(read.entries, read.next)}>
              {t('Ledger more')}
            </Button>
          ) : (
            <Totals entries={read.entries} balances={balances} />
          )}
        </>
      )}
    </div>
  );
}

/** With every line read: each asset's lines added up, beside its available balance. */
function Totals({ entries, balances }: { entries: LedgerEntry[]; balances: Loadable<Record<string, BalanceEntry>> }) {
  const { t } = deskCopy.useCopy();
  const sums = sumByAsset(entries);
  return (
    <div className="lt-table-scroll" tabIndex={0} role="region" aria-label={t('Ledger totals')}>
      <table data-testid="dk-table" className="lt-table lt-table-dense" aria-label={t('Ledger totals')}>
        <thead>
          <tr>
            <th>{t('Asset')}</th>
            <th className="lt-end">{t('Ledger lines add up to')}</th>
            <th className="lt-end">{t('Available2')}</th>
            <th>{t('Ledger check')}</th>
          </tr>
        </thead>
        <tbody>
          {[...sums].map(([asset, sum]) => {
            const free = balances.status === 'ready' ? (balances.data[asset]?.free ?? '0') : null;
            return (
              <tr key={asset} data-asset={asset}>
                <td>{asset}</td>
                <td className="lt-end lt-num">
                  <Amount value={fmtAmount(sum, { places: 18 })} />
                </td>
                <td className="lt-end lt-num">{free === null ? '—' : <Amount value={fmtAmount(free, { places: 18 })} />}</td>
                <td>
                  {free === null
                    ? t('Ledger check unknown')
                    : sameAmount(sum, free)
                      ? t('Ledger check matches')
                      : t('Ledger check differs')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Asked = { status: 'idle' } | { status: 'busy' } | { status: 'job'; job: StatementJob } | { status: 'refused'; text: string };

/** Statement export (J-cex-spot-07 #5): pick the days, ask once, then save the file the service built. */
function Statement() {
  const { t } = deskCopy.useCopy();
  const api = useDeskApi();
  const [open, setOpen] = useState(false);
  // The minute the dialog opened: a range that ends today ends here, so asking twice is the same range.
  const [asOf, setAsOf] = useState(() => new Date());
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [asked, setAsked] = useState<Asked>({ status: 'idle' });
  const [saved, setSaved] = useState<string | null>(null);

  async function ask() {
    setSaved(null);
    const picked = statementRange(fromDay, toDay, asOf);
    if (!picked.ok) {
      setAsked({
        status: 'refused',
        text: picked.why === 'future' ? t('Statement not over') : picked.why === 'order' ? t('Statement order') : t('Statement days'),
      });
      return;
    }
    setAsked({ status: 'busy' });
    const { from, to, requestKey } = picked.range;
    const result = await api.requestStatement({ from, to, requestKey });
    if (result.ok) setAsked({ status: 'job', job: result.data });
    else setAsked({ status: 'refused', text: result.code ? refusalCopy(result.code).title : t('Statement refused') });
  }

  async function save(job: StatementJob) {
    const result = await api.statementFile(job.id);
    if (!result.ok) return setSaved(t('Statement save failed'));
    // The file must be the one the job fingerprinted; anything else is not saved.
    if (result.data.sha256 !== job.sha256 || (await sha256Hex(result.data.csv)) !== job.sha256)
      return setSaved(t('Statement save mismatch'));
    const url = URL.createObjectURL(new Blob([result.data.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.data.filename;
    link.click();
    URL.revokeObjectURL(url);
    setSaved(t('Statement saved', { name: result.data.filename }));
  }

  const job = asked.status === 'job' ? asked.job : null;
  return (
    <>
      <Button
        tone="secondary"
        size="sm"
        onClick={() => {
          setAsOf(new Date());
          setAsked({ status: 'idle' });
          setSaved(null);
          setOpen(true);
        }}
      >
        {t('Statement open')}
      </Button>
      {open ? (
        <Sheet
          open
          role="alertdialog"
          title={t('Statement title')}
          description={t('Statement intro')}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button tone="secondary" size="md" onClick={() => setOpen(false)}>
                {t('Dead man close')}
              </Button>
              {job?.status === 'finished' ? (
                <Button tone="secondary" size="md" onClick={() => void save(job)}>
                  {t('Statement download')}
                </Button>
              ) : null}
              <Button busy={asked.status === 'busy'} tone="primary" size="md" onClick={() => void ask()}>
                {job?.status === 'pending' ? t('Statement check again') : t('Statement request')}
              </Button>
            </>
          }
        >
          <div className="lt-cols-2">
            <label className="lt-field">
              <span>{t('Statement from')}</span>
              <DateInput type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} />
            </label>
            <label className="lt-field">
              <span>{t('Statement to')}</span>
              <DateInput type="date" value={toDay} onChange={(event) => setToDay(event.target.value)} />
            </label>
          </div>
          <p className="lt-note">{t('Statement today', { time: clockMinutes(todayEnd(asOf).getTime(), 'UTC') })}</p>
          {asked.status === 'refused' ? (
            <p data-testid="dk-note--bad" className="lt-note lt-note-bad" role="alert">
              {asked.text}
            </p>
          ) : null}
          {job ? (
            <p data-testid={job.status === 'failed' ? 'dk-note--bad' : undefined} className={NOTE[job.status]} role="status">
              {job.status === 'finished' && job.rows
                ? t('Statement ready', { orders: job.rows.orders, trades: job.rows.trades, ledger: job.rows.ledger, id: job.id })
                : job.status === 'failed'
                  ? t('Statement too large')
                  : t('Statement pending')}
            </p>
          ) : null}
          {job?.sha256 ? <p className="lt-note lt-mono">{t('Statement fingerprint', { sha: job.sha256 })}</p> : null}
          {saved ? (
            <p className="lt-note" role="status">
              {saved}
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}
