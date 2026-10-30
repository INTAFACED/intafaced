import { useState, type FormEvent } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../shared/ui';
import { useSession } from '../session/session';
import { refusalCopy } from '../../data';
import { decodeBase64, lastFullMonth, monthIsOver, monthRange, saveFile, shortFingerprint } from '../../screens/money/statement-model';
import { statementFileSchema } from './contracts';
import { DepthPanel } from './DepthParts';
import { dayIsOver, dayRange, last30Days, STATEMENT_REPORTS, utcDay, type StatementReport } from './statement-centre-model';
import { statementCentreCopy } from './statement-centre-copy';
import './bank-depth.css';

type Said =
  { kind: 'done'; name: string; count: number; fingerprint: string } | { kind: 'refused'; words: string; code: string | null } | null;

/** The bank's typed statement refusals, each in words. */
const REFUSAL_KEYS = {
  'bank.statement_pdf_one_month': 'pdfOneMonth',
  'bank.statement_range': 'range',
  'bank.statement_too_large': 'tooLarge',
  'bank.statement_unavailable': 'unavailable',
  'bank.statement_balances_unavailable': 'balancesUnavailable',
} as const;

/**
 * `/bank/statements` (PF-statements-01): the statement and export centre. One signed door, `bank.statements.export`,
 * makes each file of the person's own posted lines: a month's account statement, the ledger or the trades between two
 * UTC days, or a balance snapshot. A month still running is not offered; every other limit is the bank's, refused in words.
 */
export function StatementCentre() {
  const { t } = statementCentreCopy.useCopy();
  const { api } = useSession();
  const [report, setReport] = useState<StatementReport>('statement');
  const [month, setMonth] = useState(() => lastFullMonth(new Date()));
  const [days, setDays] = useState(() => last30Days(new Date()));
  // A snapshot is of a day that is over: yesterday, in UTC.
  const [asOf, setAsOf] = useState(() => utcDay(new Date(Date.now() - 86_400_000)));
  const [format, setFormat] = useState<'pdf' | 'csv'>('pdf');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);

  const range = report === 'statement' ? monthRange(month) : report === 'balances' ? dayRange(asOf, asOf) : dayRange(days.from, days.to);
  const problem =
    report === 'statement'
      ? range === null
        ? t('monthNeeded')
        : !monthIsOver(month, new Date())
          ? t('monthUnfinished')
          : null
      : range === null
        ? report === 'balances'
          ? t('dayNeeded')
          : t('datesNeeded')
        : report === 'balances' && !dayIsOver(asOf, new Date())
          ? t('dayUnfinished')
          : null;

  function choose(next: StatementReport) {
    setReport(next);
    // A month's statement opens as a PDF; dates that may cross months open as a CSV, which any range up to 366 days takes.
    setFormat(next === 'statement' ? 'pdf' : 'csv');
    setSaid(null);
  }
  /** Any change to what is asked clears the last answer, which was about the old choice. */
  function changed<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setSaid(null);
    };
  }

  async function download(event: FormEvent) {
    event.preventDefault();
    if (busy || !range || problem) return;
    setBusy(true);
    setSaid(null);
    const result = await api.query('bank', 'statements.export', { from: range.from, to: range.to, format, report }, statementFileSchema);
    setBusy(false);
    if (!result.ok) {
      const code = result.code ?? null;
      const words =
        code && code in REFUSAL_KEYS ? t(REFUSAL_KEYS[code as keyof typeof REFUSAL_KEYS]) : refusalCopy(code ?? result.reason).title;
      setSaid({ kind: 'refused', words, code });
      return;
    }
    const bytes = decodeBase64(result.data.bodyBase64);
    if (!bytes) return setSaid({ kind: 'refused', words: t('unreadable'), code: null });
    saveFile(bytes, result.data.contentType, result.data.filename);
    setSaid({ kind: 'done', name: result.data.filename, count: result.data.rowCount, fingerprint: shortFingerprint(result.data.sha256) });
  }

  return (
    <DepthPanel title={t('title')} lead={t('notTaxForm')}>
      <form className="bd-stack" data-testid="statement-centre" aria-label={t('title')} onSubmit={(event) => void download(event)}>
        <fieldset className="bd-stack">
          <legend>{t('kind')}</legend>
          <div className="bd-choice-row" role="radiogroup" aria-label={t('kind')}>
            {STATEMENT_REPORTS.map((kind) => (
              <label key={kind} className={`bd-choice ${report === kind ? 'bd-choice--on' : ''}`} data-report={kind}>
                <input type="radio" name="statement-report" value={kind} checked={report === kind} onChange={() => choose(kind)} />
                <strong>{t(`report_${kind}`)}</strong>
                <span className="money-caption">{t(`report_${kind}_hint`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {report === 'statement' ? (
          <label className="field">
            <span>{t('month')}</span>
            <input type="month" value={month} max={lastFullMonth(new Date())} onChange={(event) => changed(setMonth)(event.target.value)} />
          </label>
        ) : report === 'balances' ? (
          <label className="field">
            <span>{t('asOf')}</span>
            <input type="date" value={asOf} onChange={(event) => changed(setAsOf)(event.target.value)} />
          </label>
        ) : (
          <div className="bd-choice-row">
            <label className="field">
              <span>{t('from')}</span>
              <input type="date" value={days.from} onChange={(event) => changed(setDays)({ ...days, from: event.target.value })} />
            </label>
            <label className="field">
              <span>{t('to')}</span>
              <input type="date" value={days.to} onChange={(event) => changed(setDays)({ ...days, to: event.target.value })} />
            </label>
          </div>
        )}
        <label className="field">
          <span>{t('format')}</span>
          <select value={format} onChange={(event) => changed(setFormat)(event.target.value as 'pdf' | 'csv')}>
            <option value="pdf">PDF</option>
            <option value="csv">CSV</option>
          </select>
        </label>
        <p className="money-caption">
          {t('noBalance')} {t('utcNote')}
        </p>
        <div className="actions">
          <Button type="submit" variant="secondary" disabled={busy || problem !== null}>
            <Download size={16} aria-hidden="true" />
            {t('download')}
          </Button>
        </div>
        <p role="status" aria-live="polite" data-testid="statement-centre-status">
          {problem ??
            (busy
              ? t('preparing')
              : said?.kind === 'done'
                ? t('done', { name: said.name, count: String(said.count), fingerprint: said.fingerprint })
                : '')}
        </p>
        {said?.kind === 'refused' && (
          <p role="alert" className="error-text" data-code={said.code ?? undefined}>
            {said.words}
          </p>
        )}
      </form>
    </DepthPanel>
  );
}
