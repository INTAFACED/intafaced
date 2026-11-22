import type { QuantBacktestLogLine, QuantBacktestMetrics, QuantCheck, QuantMetric } from '@intafaced/contracts/quant-algo';
import { backtestCopy } from './backtest-copy';
import { checkData, checkDetail, logText, type MetricKey, metricGroups, metricView } from './result-words';

// The figures of one bar backtest as the Backtest room draws them: the checks, the metrics and one log line in words.
// Their words live in result-words.ts, which the shared result's kit-drawn room (shared-result/) reads too.

/** Every check the service made on the run, with what it measured; nothing is folded away or hidden. */
export function ChecksTab({ checks }: { checks: readonly QuantCheck[] }) {
  const { t } = backtestCopy.useCopy();
  return (
    <div data-testid="quant-bar-checks">
      <p className="lt-hint">{t('checksIntro')}</p>
      <ul className="lt-list">
        {checks.map((check) => (
          <li
            key={check.name}
            className="lt-callout"
            data-testid={`quant-check-${check.name}`}
            data-status={check.status}
            data-threshold={check.threshold ?? ''}
            {...checkData(check)}
          >
            <h4>{t(`k_${check.name}`)}</h4>
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

/**
 * The run's report (AL-report-01), grouped in returns, risk and trades, with a help line per figure. A figure the engine
 * could not define shows the reason in words, never a zero.
 */
export function MetricsTab({ metrics }: { metrics: QuantBacktestMetrics }) {
  const { t } = backtestCopy.useCopy();
  return (
    <div data-testid="quant-bar-metrics">
      <p className="lt-hint">{t('metricsIntro')}</p>
      {metricGroups(metrics).map(([group, figures]) => (
        <section key={group} aria-label={t(group)}>
          <h4>{t(group)}</h4>
          <dl className="lt-kv">
            {Object.entries(figures).map(([key, figure]) => {
              const name = key as MetricKey;
              const view = metricView(t, name, figure as QuantMetric | number);
              return (
                <div key={key} data-testid={`quant-metric-${key}`} data-value={view.value} data-reason={view.reason}>
                  <dt>{t(`m_${name}`)}</dt>
                  <dd lang={view.reason ? undefined : 'zxx'}>{view.text}</dd>
                  <dd className="lt-hint">{t(`m_${name}_help`)}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** One log line in words; a value the copy has a word for reads as that word. */
export function LogText({ line }: { line: QuantBacktestLogLine }) {
  const { t } = backtestCopy.useCopy();
  return <>{logText(t, line)}</>;
}
