import {
  quantPublicResultSchema,
  quantReportSchema,
  quantShareCreatedSchema,
  quantShareStateSchema,
  type QuantPublicResult,
  type QuantReport,
  type QuantShareCreated,
  type QuantShareState,
} from '@intafaced/contracts/quant-algo';
import { type Dispatch, type SetStateAction, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import { backtestCopy } from './backtest-copy';
import { ChecksTab, LogText, MetricsTab } from './result-figures';
import { reportCopy } from './report-copy';
import './algo.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A shared result's totals, worded with the backtest room's own labels. */
const TOTAL_KEYS = {
  startCash: 'cash',
  gross: 'gross',
  fees: 'fees',
  slippage: 'slippageTotal',
  net: 'net',
  endEquity: 'endEquity',
  openQty: 'openQty',
} as const;

/**
 * The service's typed code for a refusal: the `quant.` code the gateway passed on, or the one the message starts with
 * (svc-quant sends `<code> — <detail>`). Never a code merely quoted somewhere inside a message.
 */
function quantCode(failure: Failed): string | null {
  if (failure.code?.startsWith('quant.')) return failure.code;
  const first = /^(quant\.[a-z_]+)\b/.exec(failure.message.trim());
  return first ? first[1]! : null;
}

/** The share refusals this room words itself; any other answer goes to the shared refusal catalogue. */
const SHARE_REFUSALS: Readonly<Record<string, 'shareRateUnset' | 'shareWindowUnset'>> = {
  'quant.share_rate_unset': 'shareRateUnset',
  'quant.share_window_unset': 'shareWindowUnset',
};

/**
 * The printable report of one stored run (AL-report-03): the six sections the service builds from the stored run on
 * each read, under the simulation label. Print opens the browser's print window, which also saves a PDF.
 */
export function ReportTab({ runId }: { runId: string }) {
  const api = useApi();
  const { t } = reportCopy.useCopy();
  const report = useResource(
    (signal) => api.query('quant', 'backtest.report', { runId }, quantReportSchema, { signal }),
    `quant-report:${runId}`,
  );
  return (
    <div data-testid="quant-report">
      <h4>{t('reportTitle')}</h4>
      <p className="muted quant-no-print">{t('reportIntro')}</p>
      {report.resource.status === 'loading' ? (
        <Loading label={t('reportLoading')} />
      ) : (
        <Read resource={report.resource} retry={report.reload}>
          {(data) => <ReportDocument report={data} />}
        </Read>
      )}
    </div>
  );
}

function ReportDocument({ report }: { report: QuantReport }) {
  const { t } = reportCopy.useCopy();
  return (
    <article className="quant-report-document" data-testid="quant-report-document" data-run-id={report.runId}>
      <p className="quant-no-print">
        <Button onClick={() => window.print()} data-testid="quant-report-print">
          {t('print')}
        </Button>
      </p>
      <p role="note" data-testid="quant-report-claim" data-simulated={String(report.simulated)} data-live={String(report.live)}>
        {report.claimLabel}
      </p>
      {report.sections.map((section) => (
        <section key={section.id} aria-label={t(`section_${section.id}`)} data-testid={`quant-report-section-${section.id}`}>
          <h5>{t(`section_${section.id}`)}</h5>
          <DataTable label={t(`section_${section.id}`)} headers={[t('rowName'), t('rowValue')]}>
            {section.rows.map((row, i) => (
              <tr key={`${row.name}:${i}`} data-testid="quant-report-row" data-name={row.name}>
                <th scope="row">{row.name}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      ))}
    </article>
  );
}

/** The once-only link a create returned, kept by the result above the tabs so moving between tabs does not lose it. */
export type CreatedShare = [QuantShareCreated | null, Dispatch<SetStateAction<QuantShareCreated | null>>];

/**
 * Share one stored run by link or embed (AL-report-03). Create sends the link count the service last read as `seq`,
 * so a press after a lost reply stores no second link; the address is shown only by the call that stored it. Revoke
 * stops the link opening. A blank read limit refuses by name; a blank frame list refuses only the embed code.
 */
export function ShareTab({ runId, created: [created, setCreated] }: { runId: string; created: CreatedShare }) {
  const api = useApi();
  const { t } = reportCopy.useCopy();
  const state = useResource(
    (signal) => api.query('quant', 'result.share.get', { runId }, quantShareStateSchema, { signal }),
    `quant-share:${runId}`,
  );
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [revoked, setRevoked] = useState(false);

  async function create(current: QuantShareState) {
    if (busy) return;
    setBusy('create');
    setFailure(null);
    setRevoked(false);
    const res = await api.mutate('quant', 'result.share.create', { runId, seq: current.links }, quantShareCreatedSchema);
    setBusy(null);
    if (res.ok) setCreated(res.data);
    else setFailure(res);
    state.reload();
  }

  async function revoke() {
    if (busy) return;
    setBusy('revoke');
    setFailure(null);
    const res = await api.mutate('quant', 'result.share.revoke', { runId }, quantShareStateSchema);
    setBusy(null);
    if (res.ok) {
      setCreated(null);
      setRevoked(true);
    } else setFailure(res);
    state.reload();
  }

  const refusal = (failed: Failed) => {
    const code = quantCode(failed);
    const own = code ? SHARE_REFUSALS[code] : undefined;
    return own ? (
      <p role="alert" data-testid="quant-share-refusal" data-code={code}>
        {t(own)}
      </p>
    ) : (
      <Failure result={failed} retry={state.reload} />
    );
  };

  return (
    <div data-testid="quant-share">
      <h4>{t('shareTitle')}</h4>
      <p className="muted">{t('shareIntro')}</p>
      {state.resource.status === 'loading' && <Loading label={t('shareLoading')} />}
      {state.resource.status === 'failed' && refusal(state.resource.failure)}
      {state.resource.status === 'ready' && (
        <ShareState
          state={state.resource.data}
          busy={busy !== null}
          onCreate={(current) => void create(current)}
          onRevoke={() => void revoke()}
        />
      )}
      {busy && <Loading label={busy === 'create' ? t('creating') : t('revoking')} />}
      {revoked && (
        <p role="status" data-testid="quant-share-revoked">
          {t('revoked')}
        </p>
      )}
      {failure && refusal(failure)}
      {created && <CreatedLink created={created} />}
    </div>
  );
}

function ShareState(props: { state: QuantShareState; busy: boolean; onCreate: (state: QuantShareState) => void; onRevoke: () => void }) {
  const { t } = reportCopy.useCopy();
  const { state } = props;
  return (
    <div data-testid="quant-share-state" data-active={String(state.active)} data-links={state.links}>
      <p>{state.active ? t('shareActive') : t('shareNone')}</p>
      <p className="muted">{t('shareCount', { count: state.links })}</p>
      {state.active ? (
        <Button onClick={props.onRevoke} disabled={props.busy} data-testid="quant-share-revoke">
          {t('revoke')}
        </Button>
      ) : (
        <Button onClick={() => props.onCreate(state)} disabled={props.busy} data-testid="quant-share-create">
          {t('create')}
        </Button>
      )}
    </div>
  );
}

/** The service's snippet frames a path on this site; another site needs the full address. */
function absoluteSnippet(snippet: string): string {
  return snippet.replace(/src="(\/[^"]*)"/, (_, path: string) => `src="${new URL(path, location.origin).toString()}"`);
}

function CreatedLink({ created }: { created: QuantShareCreated }) {
  const { t } = reportCopy.useCopy();
  if (!created.path) {
    return (
      <p role="note" data-testid="quant-share-link-lost">
        {t('linkLost')}
      </p>
    );
  }
  const url = new URL(created.path, location.origin).toString();
  return (
    <div data-testid="quant-share-created">
      <label>
        {t('linkLabel')}
        <input readOnly value={url} data-testid="quant-share-link" onFocus={(event) => event.currentTarget.select()} />
      </label>
      <p role="note" className="muted">
        {t('linkOnce')}
      </p>
      {created.embed ? (
        <div data-testid="quant-share-embed">
          <label>
            {t('embedLabel')}
            <textarea readOnly rows={3} value={absoluteSnippet(created.embed.snippet)} data-testid="quant-share-embed-code" />
          </label>
          <p className="muted">{t('embedOrigins', { origins: created.embed.origins.join(', ') })}</p>
          <p role="note" data-testid="quant-share-embed-blocked">
            {t('embedFramePolicy')}
          </p>
        </div>
      ) : (
        <p role="note" data-testid="quant-share-embed-refusal" data-code={created.embedRefusal ?? ''}>
          {t('embedUnset')}
        </p>
      )}
    </div>
  );
}

/** The share refusals a signed-out reader can get, worded plainly; anything else is the shared catalogue's. */
function publicRefusal(failure: Failed): 'publicNotFound' | 'publicBusy' | null {
  const code = quantCode(failure);
  if (code === 'quant.share_not_found') return 'publicNotFound';
  if (code === 'quant.share_rate_limited') return 'publicBusy';
  return null;
}

/**
 * What a share link opens, signed out (AL-report-03): the result under its simulation label, with the honesty checks,
 * the coverage and the figures. The service returns no account, strategy source or run key, so none can show here.
 */
export function SharedResult({ token }: { token: string }) {
  const api = useApi();
  const { t } = reportCopy.useCopy();
  const shared = useResource(
    (signal) => api.query('quant', 'result.share.public', { token }, quantPublicResultSchema, { signal }),
    `quant-shared:${token}`,
  );
  return (
    <Panel title={t('publicTitle')}>
      <div data-testid="quant-shared-result">
        {shared.resource.status === 'loading' && <Loading label={t('publicLoading')} />}
        {shared.resource.status === 'failed' &&
          (() => {
            const own = publicRefusal(shared.resource.failure);
            return own ? <EmptyState title={t(own)} /> : <Failure result={shared.resource.failure} retry={shared.reload} />;
          })()}
        {shared.resource.status === 'ready' && <PublicResult result={shared.resource.data} />}
      </div>
    </Panel>
  );
}

function PublicResult({ result }: { result: QuantPublicResult }) {
  const { t } = reportCopy.useCopy();
  const bt = backtestCopy.useCopy().t;
  const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  const { charts } = result;
  return (
    <article data-testid="quant-shared-document">
      <p role="note" data-testid="quant-shared-claim" data-simulated={String(result.simulated)} data-live={String(result.live)}>
        {result.claimLabel}
      </p>
      <p data-testid="quant-shared-window">
        {t('publicWindow', { symbol: result.symbol, from: minute(result.window.from), to: minute(result.window.to) })}
      </p>
      <p data-testid="quant-shared-coverage">{t('publicCoverage', { bars: result.coverage.bars, expected: result.coverage.expected })}</p>
      <p data-testid="quant-shared-costs">
        {t('publicCosts', {
          feeRole: result.costs.feeRole,
          feeBps: result.costs.feeBps,
          slippageBps: result.costs.slippageBps,
          delayBars: result.costs.delayBars,
        })}
      </p>
      <p data-testid="quant-shared-verdict" data-status={result.verdict.status}>
        {t('publicVerdict', { status: bt(`v_${result.verdict.status}`) })}
      </p>
      <p data-testid="quant-shared-variants">
        {result.variantCount === null ? t('publicVariantsUnknown') : t('publicVariants', { count: result.variantCount })}
      </p>
      <section aria-label={t('publicTotals')}>
        <h4>{t('publicTotals')}</h4>
        <dl className="quant-bar-totals" data-testid="quant-shared-totals">
          {(Object.keys(TOTAL_KEYS) as (keyof typeof TOTAL_KEYS)[])
            .map((key) => [key, result.totals[key]] as const)
            .map(([key, value]) => (
              <div key={key} data-testid={`quant-shared-total-${key}`} data-value={value}>
                <dt>{bt(TOTAL_KEYS[key as keyof typeof TOTAL_KEYS])}</dt>
                <dd lang="zxx">{value}</dd>
              </div>
            ))}
        </dl>
      </section>
      <section aria-label={t('publicMetrics')}>
        <h4>{t('publicMetrics')}</h4>
        <MetricsTab metrics={result.metrics} />
      </section>
      <section aria-label={t('publicChecks')}>
        <h4>{t('publicChecks')}</h4>
        <ChecksTab checks={result.checks} />
      </section>
      <p data-testid="quant-shared-chart">
        {charts.points === 0 || !charts.first || !charts.last
          ? t('publicChartNone')
          : t('publicChart', {
              points: charts.points,
              first: charts.first.equity,
              last: charts.last.equity,
              low: charts.low ?? t('notDefined'),
              high: charts.high ?? t('notDefined'),
            })}
      </p>
      <section aria-label={t('publicWarnings')}>
        <h4>{t('publicWarnings')}</h4>
        {result.warnings.length === 0 ? (
          <p className="muted">{t('publicNoWarnings')}</p>
        ) : (
          <ul data-testid="quant-shared-warnings">
            {result.warnings.map((line, i) => (
              <li key={`${line.code}:${i}`} data-code={line.code}>
                {line.ts && <span lang="zxx">{minute(line.ts)} </span>}
                <LogText line={line} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
