import { useEffect, useState, type FormEvent } from 'react';
import { Download } from 'lucide-react';
import { Button, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { decodeBase64, saveFile, shortFingerprint } from '../../screens/money/statement-model';
import { amount, bps, date, useBankRead } from './components';
import { loanStatementSchema, type LoanInterestRows, type LoanLedgerCheck, type LoanProjection, type PayoffQuote } from './contracts';
import { DepthPanel } from './DepthParts';
import { loanDetailCopy } from './loan-detail-copy';
import './bank-depth.css';

/**
 * `/bank/loans/detail?loan=<id>` (J-bank-11 #1, #4 and #6, BK-loan-06, LOAN-05): one loan's payoff quote, a
 * projection of its interest, its interest rows with any corrections, the bank's check of the loan against the ledger,
 * and its monthly statement. Every figure is the bank's own answer (`bank.loans.payoffQuote`, `bank.loans.projection`,
 * `bank.loans.interestRows`, `bank.loans.ledgerCheck`, `bank.loans.statement`): the browser works nothing out. The projection is labelled as one,
 * never as a schedule, and the quote is read again on request and never stored.
 */

type Copy = ReturnType<typeof loanDetailCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

export const PROJECTION_DAYS = [7, 30, 90, 180, 365] as const;
type Days = (typeof PROJECTION_DAYS)[number];
const DECIMAL = /^\d+(\.\d{1,18})?$/;

/** What a refused loan read says, by the bank's code, with the code as a reference. Anything else keeps its own message. */
export function loanRefusal(t: Copy, failure: Pick<Failed, 'code' | 'message' | 'reason'>): string {
  const code = failure.code ?? '';
  const words =
    code === 'bank.loan_fee_unset'
      ? t('feeUnset')
      : code === 'bank.loan_payoff_window_unset'
        ? t('windowUnset')
        : code === 'bank.loan_closed'
          ? t('closed')
          : code === 'bank.loan_liquidating'
            ? t('liquidating')
            : code === 'bank.loan_fee_unsupported'
              ? t('feeUnsupported')
              : code === 'bank.loan_terms_missing'
                ? t('termsMissing')
                : code === 'bank.statement_too_large'
                  ? t('stTooLarge')
                  : code === 'bank.statement_range'
                    ? t('stRange')
                    : code === 'bank.ledger_outcome_unknown'
                      ? t('outcomeUnknown')
                      : code === 'bank.accrual_backlog'
                        ? t('backlog')
                        : code === 'bank.loan_not_drawable'
                          ? t('notDrawn')
                          : code === 'bank.loan_not_found'
                            ? t('notYours')
                            : failure.message;
  return code.includes('.') ? `${words} ${t('reference', { code })}` : words;
}

function Refused({ failure, retry, label }: { failure: Failed; retry: () => void; label: string }) {
  const { t } = loanDetailCopy.useCopy();
  return (
    <div role="alert" className="error-text" data-code={failure.code ?? ''}>
      <p>{loanRefusal(t, failure)}</p>
      <Button variant="ghost" onClick={retry}>
        {label}
      </Button>
    </div>
  );
}

/** The terms snapshotted on the loan at open (J-bank-09 #5): read from the loan, never from its product. */
function TermsPanel({ loanId }: { loanId: string }) {
  const { t } = loanDetailCopy.useCopy();
  const terms = useBankRead('loans.terms', { loanId });
  const threshold = (value: number | null) => (value === null ? t('termsNotWritten') : bps(value));
  return (
    <DepthPanel title={t('termsTitle')} lead={t('termsLead')}>
      {terms.resource.status === 'loading' && <Loading />}
      {terms.resource.status === 'failed' && <Refused failure={terms.resource.failure} retry={terms.reload} label={t('retry')} />}
      {terms.resource.status === 'ready' && (
        <dl
          className="detail-list"
          data-testid="loan-terms"
          data-apr-bps={String(terms.resource.data.aprBps)}
          data-margin-call-bps={String(terms.resource.data.marginCallLtvBps ?? '')}
          data-liquidation-bps={String(terms.resource.data.liquidationLtvBps ?? '')}
        >
          <div>
            <dt>{t('termsRate')}</dt>
            <dd>{bps(terms.resource.data.aprBps)}</dd>
          </div>
          <div>
            <dt>{t('termsMarginCall')}</dt>
            <dd>{threshold(terms.resource.data.marginCallLtvBps)}</dd>
          </div>
          <div>
            <dt>{t('termsLiquidation')}</dt>
            <dd>{threshold(terms.resource.data.liquidationLtvBps)}</dd>
          </div>
          <div>
            <dt>{t('termsPrincipal')}</dt>
            <dd>{amount(terms.resource.data.principal, terms.resource.data.debtAssetId)}</dd>
          </div>
          <div>
            <dt>{t('termsCollateral')}</dt>
            <dd>
              {terms.resource.data.openingCollateral === null
                ? t('termsNotWritten')
                : amount(terms.resource.data.openingCollateral, terms.resource.data.collateralAssetId)}
            </dd>
          </div>
          <div>
            <dt>{t('termsOpened')}</dt>
            <dd>{date(terms.resource.data.openedAt)}</dd>
          </div>
        </dl>
      )}
    </DepthPanel>
  );
}

function QuotePanel({ loanId }: { loanId: string }) {
  const { t } = loanDetailCopy.useCopy();
  const quote = useBankRead('loans.payoffQuote', { loanId });
  const reload = quote.reload;
  return (
    <DepthPanel title={t('quoteTitle')} lead={t('quoteLead')}>
      {quote.resource.status === 'loading' && <Loading />}
      {quote.resource.status === 'failed' && <Refused failure={quote.resource.failure} retry={reload} label={t('quoteRefresh')} />}
      {quote.resource.status === 'ready' && <QuoteFigures quote={quote.resource.data} reload={reload} />}
    </DepthPanel>
  );
}

/** True once `until` has passed, turning by itself at that moment so a page left open stops offering an old price. */
function usePassed(until: string): boolean {
  const at = Date.parse(until);
  const [passed, setPassed] = useState(() => !(at > Date.now()));
  useEffect(() => {
    if (!(at > Date.now())) return setPassed(true);
    setPassed(false);
    // A browser timer holds at most about 24.8 days; a quote holds minutes, never past the day's end.
    const timer = window.setTimeout(() => setPassed(true), Math.min(at - Date.now(), 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [at]);
  return passed;
}

function QuoteFigures({ quote, reload }: { quote: PayoffQuote; reload: () => void }) {
  const { t } = loanDetailCopy.useCopy();
  const expired = usePassed(quote.validUntil);
  return (
    <div
      className="bd-stack"
      data-testid="loan-quote"
      data-total={quote.total}
      data-valid-until={quote.validUntil}
      data-expired={String(expired)}
    >
      <dl className="detail-list">
        <div>
          <dt>{t('quotePrincipal')}</dt>
          <dd>{amount(quote.principal, quote.assetId)}</dd>
        </div>
        <div>
          <dt>{t('quoteInterest', { date: quote.interestThrough })}</dt>
          <dd data-testid="loan-quote-interest" data-value={quote.interest}>
            {amount(quote.interest, quote.assetId)}
          </dd>
        </div>
        <div>
          <dt>{t('quoteFee')}</dt>
          <dd>{amount(quote.fee, quote.assetId)}</dd>
        </div>
        <div>
          <dt>
            <strong>{t('quoteTotal')}</strong>
          </dt>
          <dd>
            <strong>{amount(quote.total, quote.assetId)}</strong>
          </dd>
        </div>
      </dl>
      <p className={expired ? 'error-text' : 'money-caption'} role={expired ? 'alert' : undefined}>
        {expired ? t('quoteExpired') : t('quoteValid', { time: date(quote.validUntil) })}
      </p>
      <div className="actions">
        <Button variant="secondary" onClick={reload}>
          {t('quoteRefresh')}
        </Button>
        <a className="text-link" href="/bank/loans">
          {t('quoteRepay')}
        </a>
      </div>
    </div>
  );
}

function ProjectionPanel({ loanId, assetId }: { loanId: string; assetId: string }) {
  const { t } = loanDetailCopy.useCopy();
  const [days, setDays] = useState<Days>(30);
  const [extra, setExtra] = useState('');
  const [asked, setAsked] = useState<{ days: Days; extra: string }>({ days: 30, extra: '' });
  const [invalid, setInvalid] = useState(false);
  const projection = useBankRead('loans.projection', {
    loanId,
    days: asked.days,
    ...(asked.extra ? { extraRepayment: asked.extra } : {}),
  });

  function show(event: FormEvent) {
    event.preventDefault();
    const what = extra.trim();
    if (what !== '' && !DECIMAL.test(what)) return setInvalid(true);
    setInvalid(false);
    setAsked({ days, extra: what });
  }

  return (
    <DepthPanel title={t('projTitle')} lead={t('projLead')}>
      <p>
        <span className="badge" data-testid="loan-projection-label">
          {t('projBadge')}
        </span>
      </p>
      <form className="bd-stack" onSubmit={show} noValidate>
        <label className="field">
          <span>{t('projDays')}</span>
          <select value={String(days)} onChange={(event) => setDays(Number(event.target.value) as Days)}>
            {PROJECTION_DAYS.map((n) => (
              <option key={n} value={String(n)}>
                {t(`days_${n}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('projWhatIf')}</span>
          <input value={extra} inputMode="decimal" onChange={(event) => setExtra(event.target.value)} aria-describedby="loan-whatif-hint" />
          <small id="loan-whatif-hint" className="muted">
            {t('projWhatIfHint')}
          </small>
        </label>
        <div className="actions">
          <Button type="submit" variant="secondary">
            {t('projShow')}
          </Button>
        </div>
        {invalid && (
          <p role="alert" className="error-text">
            {t('projInvalid')}
          </p>
        )}
      </form>
      {projection.resource.status === 'loading' && <Loading />}
      {projection.resource.status === 'failed' && (
        <Refused failure={projection.resource.failure} retry={projection.reload} label={t('projShow')} />
      )}
      {projection.resource.status === 'ready' && <ProjectionTable projection={projection.resource.data} assetId={assetId} />}
    </DepthPanel>
  );
}

function ProjectionTable({ projection, assetId }: { projection: LoanProjection; assetId: string }) {
  const { t } = loanDetailCopy.useCopy();
  return (
    <div className="bd-stack">
      <p className="money-caption">
        {t('projRate', { apr: bps(projection.aprBps) })}{' '}
        {t('projOpening', {
          principal: amount(projection.openingPrincipal, assetId),
          interest: amount(projection.openingInterest, assetId),
        })}
        {projection.extraApplied !== null && <> {t('projExtra', { amount: amount(projection.extraApplied, assetId) })}</>}
      </p>
      <div className="withdrawal-address-scroll">
        <table
          className="bd-table"
          data-testid="loan-projection"
          data-kind={projection.kind}
          data-obligation={String(projection.obligation)}
          data-days={projection.days}
        >
          <caption className="muted">{t('projBadge')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('colDate')}</th>
              <th scope="col">{t('colBasis')}</th>
              <th scope="col">{t('colInterest')}</th>
              <th scope="col">{t('colDebt')}</th>
            </tr>
          </thead>
          <tbody>
            {projection.rows.map((row) => (
              <tr key={row.date} data-date={row.date} data-basis={row.basis} data-interest={row.interest} data-debt={row.debt}>
                <td>{row.date}</td>
                <td>{amount(row.basis, assetId)}</td>
                <td>{amount(row.interest, assetId)}</td>
                <td>{amount(row.debt, assetId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A signed bank figure with its sign shown: a correction can take interest off or add it. */
const signed = (value: string, assetId: string) =>
  value.startsWith('-') ? `−${amount(value.slice(1), assetId)}` : `+${amount(value, assetId)}`;

function InterestPanel({ loanId }: { loanId: string }) {
  const { t } = loanDetailCopy.useCopy();
  const rows = useBankRead('loans.interestRows', { loanId });
  return (
    <DepthPanel title={t('irTitle')} lead={t('irLead')}>
      {rows.resource.status === 'loading' && <Loading />}
      {rows.resource.status === 'failed' && <Refused failure={rows.resource.failure} retry={rows.reload} label={t('retry')} />}
      {rows.resource.status === 'ready' && <InterestTables rows={rows.resource.data} />}
    </DepthPanel>
  );
}

function InterestTables({ rows }: { rows: LoanInterestRows }) {
  const { t } = loanDetailCopy.useCopy();
  const asset = rows.assetId;
  return (
    <div className="bd-stack" data-testid="loan-interest" data-owed={rows.owed} data-accrued={rows.accrued} data-corrected={rows.corrected}>
      <dl className="detail-list">
        <div>
          <dt>{t('irAccrued')}</dt>
          <dd>{amount(rows.accrued, asset)}</dd>
        </div>
        <div>
          <dt>{t('irCorrected')}</dt>
          <dd>{rows.corrections.length === 0 ? amount('0', asset) : signed(rows.corrected, asset)}</dd>
        </div>
        <div>
          <dt>{t('irPaid')}</dt>
          <dd>{amount(rows.paid, asset)}</dd>
        </div>
        <div>
          <dt>
            <strong>{t('irOwed')}</strong>
          </dt>
          <dd>
            <strong>{amount(rows.owed, asset)}</strong>
          </dd>
        </div>
      </dl>
      {rows.corrections.length === 0 ? (
        <p className="muted">{t('irNoCorrections')}</p>
      ) : (
        <div className="withdrawal-address-scroll">
          <table className="bd-table" data-testid="loan-corrections">
            <caption className="muted">{t('irCorrected')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('colWhen')}</th>
                <th scope="col">{t('colCorrection')}</th>
                <th scope="col">{t('colReason')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.corrections.map((c) => (
                <tr key={c.id} data-id={c.id} data-amount={c.amount}>
                  <td>{date(c.at)}</td>
                  <td>{signed(c.amount, asset)}</td>
                  <td>{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.days.length === 0 ? (
        <p className="muted">{t('irNoDays')}</p>
      ) : (
        <div className="withdrawal-address-scroll">
          <table className="bd-table" data-testid="loan-interest-days">
            <caption className="muted">{t('irDays')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('colDate')}</th>
                <th scope="col">{t('colBasis')}</th>
                <th scope="col">{t('colRate')}</th>
                <th scope="col">{t('colInterest')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.days.map((d) => (
                <tr key={d.date} data-date={d.date} data-basis={d.basis} data-interest={d.interest}>
                  <td>{d.date}</td>
                  <td>{amount(d.basis, asset)}</td>
                  <td>{bps(d.rateBps)}</td>
                  <td>{amount(d.interest, asset)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.earlierDays > 0 && <p className="muted">{t('irEarlier', { count: String(rows.earlierDays) })}</p>}
    </div>
  );
}

const CHECK_KINDS = [
  'draw',
  'repayment',
  'collateral_lock',
  'collateral_release',
  'liquidation',
  'bad_debt',
  'collateral_balance',
] as const;
const CHECK_PROBLEMS = ['missing', 'key', 'entries', 'balance'] as const;

/** One difference the bank found, in words: which move, and how the ledger differs. */
export function ledgerMismatch(t: Copy, m: { kind: string; ref: string; problem: string }): string {
  const what = (CHECK_KINDS as readonly string[]).includes(m.kind)
    ? t(`ck_${m.kind as (typeof CHECK_KINDS)[number]}`, { ref: m.ref })
    : t('ck_other', { ref: m.ref });
  const how = (CHECK_PROBLEMS as readonly string[]).includes(m.problem)
    ? t(`ckp_${m.problem as (typeof CHECK_PROBLEMS)[number]}`)
    : t('ckp_other');
  return `${what}: ${how}`;
}

function LedgerCheckPanel({ loanId, collateralAssetId }: { loanId: string; collateralAssetId: string }) {
  const { t } = loanDetailCopy.useCopy();
  const check = useBankRead('loans.ledgerCheck', { loanId });
  return (
    <DepthPanel title={t('ckTitle')} lead={t('ckLead')}>
      {check.resource.status === 'loading' && <Loading />}
      {check.resource.status === 'failed' && <Refused failure={check.resource.failure} retry={check.reload} label={t('ckRefresh')} />}
      {check.resource.status === 'ready' && (
        <LedgerCheckResult check={check.resource.data} collateralAssetId={collateralAssetId} reload={check.reload} />
      )}
    </DepthPanel>
  );
}

function LedgerCheckResult({
  check,
  collateralAssetId,
  reload,
}: {
  check: LoanLedgerCheck;
  collateralAssetId: string;
  reload: () => void;
}) {
  const { t } = loanDetailCopy.useCopy();
  return (
    <div className="bd-stack" data-testid="loan-ledger-check" data-status={check.status} data-checked={check.checked}>
      <p role={check.status === 'differs' ? 'alert' : undefined} className={check.status === 'differs' ? 'error-text' : undefined}>
        {check.status === 'agrees'
          ? t('ckAgrees', { count: String(check.checked), held: amount(check.collateralHeld, collateralAssetId) })
          : check.status === 'differs'
            ? t('ckDiffers', { count: String(check.mismatches.length) })
            : t('ckPending')}
      </p>
      {check.mismatches.length > 0 && (
        <ul>
          {check.mismatches.map((m) => (
            <li key={`${m.kind}:${m.ref}:${m.problem}`}>{ledgerMismatch(t, m)}</li>
          ))}
        </ul>
      )}
      <p className="money-caption">{t('ckWhen', { time: date(check.checkedAt, true) })}</p>
      <div className="actions">
        <Button variant="secondary" onClick={reload}>
          {t('ckRefresh')}
        </Button>
      </div>
    </div>
  );
}

type StatementSaid =
  | { kind: 'done'; name: string; count: number; fingerprint: string; totals: string; provisional: boolean }
  | { kind: 'error'; words: string }
  | null;

const thisMonth = (now: Date) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * One UTC month as the bank's loan statement reads a period: from its first instant to the next month's first instant,
 * the end not included. The bank charges interest by day and leaves out the day `to` falls on, so an end of 23:59:59.999
 * on the last day would drop that day's interest from the month.
 */
export function loanStatementMonth(month: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return { from: new Date(Date.UTC(year, index, 1)).toISOString(), to: new Date(Date.UTC(year, index + 1, 1)).toISOString() };
}

function StatementPanel({ loanId, assetId }: { loanId: string; assetId: string }) {
  const { t } = loanDetailCopy.useCopy();
  const { api } = useSession();
  const [month, setMonth] = useState(() => thisMonth(new Date()));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<StatementSaid>(null);
  const range = loanStatementMonth(month);

  async function download(event: FormEvent) {
    event.preventDefault();
    if (busy || !range) return;
    setBusy(true);
    setSaid(null);
    // The whole month is asked for: the bank marks a month still running provisional and closes it at the moment it answers.
    const result = await api.query('bank', 'loans.statement', { loanId, from: range.from, to: range.to }, loanStatementSchema);
    setBusy(false);
    if (!result.ok) {
      setSaid({ kind: 'error', words: result.code === 'bank.statement_unavailable' ? t('stUnavailable') : loanRefusal(t, result) });
      return;
    }
    const bytes = decodeBase64(result.data.bodyBase64);
    if (!bytes) return setSaid({ kind: 'error', words: t('stUnreadable') });
    saveFile(bytes, result.data.contentType, result.data.filename);
    setSaid({
      kind: 'done',
      name: result.data.filename,
      count: result.data.rowCount,
      fingerprint: shortFingerprint(result.data.sha256),
      provisional: result.data.provisional,
      totals: t('stTotals', {
        openingPrincipal: amount(result.data.openingPrincipal, assetId),
        openingInterest: amount(result.data.openingInterest, assetId),
        closingPrincipal: amount(result.data.closingPrincipal, assetId),
        closingInterest: amount(result.data.closingInterest, assetId),
      }),
    });
  }

  return (
    <DepthPanel title={t('stTitle')} lead={t('stLead')}>
      <form className="bd-stack" onSubmit={(event) => void download(event)} data-testid="loan-statement">
        <label className="field">
          <span>{t('stMonth')}</span>
          <input type="month" value={month} max={thisMonth(new Date())} onChange={(event) => setMonth(event.target.value)} />
        </label>
        <div className="actions">
          <Button type="submit" variant="secondary" disabled={busy || !range}>
            <Download size={16} aria-hidden="true" />
            {t('stDownload')}
          </Button>
        </div>
        <div role="status" aria-live="polite">
          {!range && <p>{t('stMonthNeeded')}</p>}
          {busy && <p>{t('stPreparing')}</p>}
          {said?.kind === 'done' && (
            <>
              <p>{t('stDone', { name: said.name, count: String(said.count), fingerprint: said.fingerprint })}</p>
              <p>{said.totals}</p>
              {said.provisional && <p className="muted">{t('stProvisional')}</p>}
            </>
          )}
        </div>
        {said?.kind === 'error' && (
          <p role="alert" className="error-text">
            {said.words}
          </p>
        )}
      </form>
    </DepthPanel>
  );
}

/** The page: the loan named in the address, read from the person's own loans so its asset is known. */
export function LoanDetail({ loanId }: { loanId: string | null }) {
  const { t } = loanDetailCopy.useCopy();
  const loans = useBankRead('loans.list', { limit: 200 }, loanId !== null);
  if (loanId === null) {
    return (
      <p role="note">
        {t('noLoan')}{' '}
        <a className="text-link" href="/bank/loans">
          {t('back')}
        </a>
      </p>
    );
  }
  if (loans.resource.status === 'loading') return <Loading />;
  if (loans.resource.status === 'failed') return <Refused failure={loans.resource.failure} retry={loans.reload} label={t('retry')} />;
  const loan = loans.resource.data.find((one) => one.id === loanId);
  if (!loan) {
    return (
      <p role="alert" className="error-text">
        {t('notYours')}{' '}
        <a className="text-link" href="/bank/loans">
          {t('back')}
        </a>
      </p>
    );
  }
  return (
    <div className="bd-stack" data-loan-id={loan.id}>
      <p className="money-caption" lang="und">
        {t('loanRef', { id: loan.id })}
      </p>
      <TermsPanel loanId={loan.id} />
      <QuotePanel loanId={loan.id} />
      <ProjectionPanel loanId={loan.id} assetId={loan.debtAssetId} />
      <InterestPanel loanId={loan.id} />
      <LedgerCheckPanel loanId={loan.id} collateralAssetId={loan.collateralAssetId} />
      <StatementPanel loanId={loan.id} assetId={loan.debtAssetId} />
      <p>
        <a className="text-link" href="/bank/loans">
          {t('back')}
        </a>
      </p>
    </div>
  );
}
