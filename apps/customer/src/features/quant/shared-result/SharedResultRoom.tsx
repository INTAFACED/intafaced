// volt-room: /quant/share/:token
import type { QuantBacktestMetrics, QuantCheck, QuantMetric, QuantPublicResult } from '@intafaced/contracts/quant-algo';
import { QUANT_RESULT_SHARE_PUBLIC } from '@intafaced/contracts/quant-result-share-procedures';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { EmptyNote, FailureNote, Waiting } from '../../more';
import { useApi } from '../../session';
import { backtestCopy } from '../backtest-copy';
import { reportCopy } from '../report-copy';
import {
  checkData,
  checkDetail,
  logText,
  type MetricKey,
  metricGroups,
  metricView,
  publicRefusal,
  TOTAL_KEYS,
  utcText,
} from '../result-words';

/**
 * /quant/share/:token on the reading template: what a share link opens, signed in or not (AL-report-03). The result
 * under its simulation label, with the honesty checks, the coverage and the figures. The service returns no account,
 * strategy source or run key, so none can show here. The Backtest room draws the same figures with its own parts; both
 * word them from result-words.ts.
 */
export function SharedResult({ token }: { token: string }) {
  const api = useApi();
  const { t } = reportCopy.useCopy();
  const shared = useResource((signal) => api.call(QUANT_RESULT_SHARE_PUBLIC, { token }, { signal }), `quant-shared:${token}`);
  const failed = shared.resource.status === 'failed' ? shared.resource.failure : null;
  const own = failed ? publicRefusal(failed) : null;
  return (
    <ReadingTemplate
      title={t('publicTitle')}
      state={{ kind: 'ready' }}
      body={
        <div data-testid="quant-shared-result">
          {shared.resource.status === 'loading' && <Waiting label={t('publicLoading')} />}
          {failed &&
            (own ? (
              <EmptyNote title={t(own)} />
            ) : (
              <div lang="und">
                <FailureNote result={failed} retry={shared.reload} />
              </div>
            ))}
          {shared.resource.status === 'ready' && <PublicResult result={shared.resource.data} />}
        </div>
      }
    />
  );
}

function PublicResult({ result }: { result: QuantPublicResult }) {
  const { t } = reportCopy.useCopy();
  const bt = backtestCopy.useCopy().t;
  const { charts } = result;
  return (
    <article className="lt-stack" data-testid="quant-shared-document">
      <p role="note" data-testid="quant-shared-claim" data-simulated={String(result.simulated)} data-live={String(result.live)}>
        {result.claimLabel}
      </p>
      <p data-testid="quant-shared-window">
        {t('publicWindow', { symbol: result.symbol, from: utcText(result.window.from), to: utcText(result.window.to) })}
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
        <h2>{t('publicTotals')}</h2>
        <dl className="lt-kv" data-testid="quant-shared-totals">
          {(Object.keys(TOTAL_KEYS) as (keyof typeof TOTAL_KEYS)[])
            .map((key) => [key, result.totals[key]] as const)
            .map(([key, value]) => (
              <div key={key} data-testid={`quant-shared-total-${key}`} data-value={value}>
                <dt>{bt(TOTAL_KEYS[key])}</dt>
                <dd lang="zxx">{value}</dd>
              </div>
            ))}
        </dl>
      </section>
      <section aria-label={t('publicMetrics')}>
        <h2>{t('publicMetrics')}</h2>
        <Metrics metrics={result.metrics} />
      </section>
      <section aria-label={t('publicChecks')}>
        <h2>{t('publicChecks')}</h2>
        <Checks checks={result.checks} />
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
        <h2>{t('publicWarnings')}</h2>
        {result.warnings.length === 0 ? (
          <p className="lt-hint">{t('publicNoWarnings')}</p>
        ) : (
          <ul data-testid="quant-shared-warnings">
            {result.warnings.map((line, i) => (
              <li key={`${line.code}:${i}`} data-code={line.code}>
                {line.ts && <span lang="zxx">{utcText(line.ts)} </span>}
                {logText(bt, line)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

/** Every check the service made on the run, with what it measured; nothing is folded away or hidden. */
function Checks({ checks }: { checks: readonly QuantCheck[] }) {
  const { t } = backtestCopy.useCopy();
  return (
    <div className="lt-stack" data-testid="quant-bar-checks">
      <p className="lt-hint">{t('checksIntro')}</p>
      <ul className="lt-stack">
        {checks.map((check) => (
          <li
            key={check.name}
            data-testid={`quant-check-${check.name}`}
            data-status={check.status}
            data-threshold={check.threshold ?? ''}
            {...checkData(check)}
          >
            <h3>{t(`k_${check.name}`)}</h3>
            <p>
              <strong>{t(`s_${check.status}`)}</strong>
            </p>
            <p>{checkDetail(t, check)}</p>
            {check.threshold !== null && <p className="lt-hint">{t('checkThreshold', { threshold: check.threshold })}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The run's figures in returns, risk and trades, each with its help line; an undefined figure gives its reason. */
function Metrics({ metrics }: { metrics: QuantBacktestMetrics }) {
  const { t } = backtestCopy.useCopy();
  return (
    <div className="lt-stack" data-testid="quant-bar-metrics">
      <p className="lt-hint">{t('metricsIntro')}</p>
      {metricGroups(metrics).map(([group, figures]) => (
        <section key={group} aria-label={t(group)}>
          <h3>{t(group)}</h3>
          <dl className="lt-kv">
            {Object.entries(figures).map(([key, figure]) => {
              const name = key as MetricKey;
              const view = metricView(t, name, figure as QuantMetric | number);
              return (
                <div key={key} data-testid={`quant-metric-${key}`} data-value={view.value} data-reason={view.reason}>
                  <dt>{t(`m_${name}`)}</dt>
                  <dd>
                    <span lang={view.reason ? undefined : 'zxx'}>{view.text}</span>
                    <span className="lt-kv-note">{t(`m_${name}_help`)}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
