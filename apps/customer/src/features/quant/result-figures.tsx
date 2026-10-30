import type { QuantBacktestLogLine, QuantBacktestMetrics, QuantCheck, QuantMetric } from '@intafaced/contracts/quant-algo';
import { backtestCopy } from './backtest-copy';

// The figures of one bar backtest that both the owner's result and a shared result show: the checks, the metrics and
// one log line in words. Kept apart from the Backtest room so the shared page does not import the room.

const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');

type MetricKey = keyof QuantBacktestMetrics['returns'] | keyof QuantBacktestMetrics['risk'] | keyof QuantBacktestMetrics['trades'];
const REASONS = ['no_trades', 'no_winning_trades', 'no_losing_trades', 'too_few_equity_points', 'zero_base'] as const;

const NOT_CHECKED = ['not_split', 'section_undefined', 'not_counted', 'too_few_bars', 'return_undefined', 'not_run'] as const;

/** Every check the service made on the run, with what it measured; nothing is folded away or hidden. */
export function ChecksTab({ checks }: { checks: readonly QuantCheck[] }) {
  const { t } = backtestCopy.useCopy();
  const figure = (check: QuantCheck, name: string) => check.evidence[name] ?? t('notSet');
  const detail = (check: QuantCheck): string => {
    if (check.status === 'not_applicable') {
      const reason = check.evidence.reason ?? '';
      return (NOT_CHECKED as readonly string[]).includes(reason)
        ? t(`na_${reason as (typeof NOT_CHECKED)[number]}`)
        : t('na_other', { reason });
    }
    switch (check.name) {
      case 'sample_gap':
        return t('d_sample_gap', {
          inSample: figure(check, 'inSampleReturnPercent'),
          outOfSample: figure(check, 'outOfSampleReturnPercent'),
          gap: figure(check, 'gapPercent'),
        });
      case 'variant_count':
        return t('d_variant_count', { variants: figure(check, 'variants') });
      case 'bar_offset':
        return t('d_bar_offset', {
          base: figure(check, 'returnPercent'),
          from: check.evidence.offsetFrom ? utcText(check.evidence.offsetFrom) : t('notSet'),
          offset: figure(check, 'offsetReturnPercent'),
          shift: figure(check, 'shiftPercent'),
        });
      case 'bar_type':
        return check.evidence.kind === 'time'
          ? t('d_bar_type', { barSize: figure(check, 'barSize') })
          : t('d_bar_type_other', { barSize: figure(check, 'barSize') });
      case 'look_ahead':
        return t('d_look_ahead');
      case 'repainting':
        return t('d_repainting');
    }
  };
  return (
    <div data-testid="quant-bar-checks">
      <p className="muted">{t('checksIntro')}</p>
      <ul className="quant-checks">
        {checks.map((check) => (
          <li
            key={check.name}
            data-testid={`quant-check-${check.name}`}
            data-status={check.status}
            data-threshold={check.threshold ?? ''}
            {...Object.fromEntries(Object.entries(check.evidence).map(([name, value]) => [`data-${name.toLowerCase()}`, value ?? '']))}
          >
            <h4>{t(`k_${check.name}`)}</h4>
            <p>
              <strong>{t(`s_${check.status}`)}</strong>
            </p>
            <p>{detail(check)}</p>
            {check.threshold !== null && <p className="muted">{t('checkThreshold', { threshold: check.threshold })}</p>}
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
  const reasonText = (reason: string) =>
    reason === 'quant.risk_free_unset'
      ? t('r_risk_free_unset')
      : (REASONS as readonly string[]).includes(reason)
        ? t(`r_${reason as (typeof REASONS)[number]}`)
        : t('r_other', { reason });
  const shown = (key: MetricKey, value: QuantMetric | number) => {
    if (typeof value === 'number') return { text: String(value), value: String(value), reason: '' };
    if (value.value === null) return { text: reasonText(value.reason ?? ''), value: '', reason: value.reason ?? '' };
    // Holding time arrives in milliseconds and reads in whole seconds.
    const text = key === 'averageHoldingMs' ? String(Math.floor(Number(value.value) / 1_000)) : value.value;
    return { text, value: value.value, reason: '' };
  };
  const groups = [
    ['groupReturns', metrics.returns],
    ['groupRisk', metrics.risk],
    ['groupTrades', metrics.trades],
  ] as const;
  return (
    <div data-testid="quant-bar-metrics">
      <p className="muted">{t('metricsIntro')}</p>
      {groups.map(([group, figures]) => (
        <section key={group} aria-label={t(group)}>
          <h4>{t(group)}</h4>
          <dl className="quant-bar-totals">
            {Object.entries(figures).map(([key, figure]) => {
              const name = key as MetricKey;
              const view = shown(name, figure as QuantMetric | number);
              return (
                <div key={key} data-testid={`quant-metric-${key}`} data-value={view.value} data-reason={view.reason}>
                  <dt>{t(`m_${name}`)}</dt>
                  <dd lang={view.reason ? undefined : 'zxx'}>{view.text}</dd>
                  <dd className="muted">{t(`m_${name}_help`)}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Values the log carries as codes (a side, a reason, a modelling choice) read in words where the copy has them. */
const LOG_WORDS = new Set([
  'buy',
  'sell',
  'signal',
  'stop_loss',
  'take_profit',
  'stop_out',
  'margin_call',
  'insufficient_cash',
  'no_size',
  'unfilled_at_window_end',
  'long_only',
  'averages_over_traded_bars',
  'stop_loss_first',
  'take_profit_without_slippage',
  'stop_out_before_exits',
  'margin_level_at_bar_low',
  'loss_beyond_margin',
  'open_position_marked_at_last_close',
  'risk_limits_not_simulated',
]);

/** One log line in words; a value the copy has a word for reads as that word. */
export function LogText({ line }: { line: QuantBacktestLogLine }) {
  const { t } = backtestCopy.useCopy();
  const readable = Object.fromEntries(
    // Every word in LOG_WORDS is a copy key that takes no values.
    Object.entries(line.values).map(([key, value]) => [key, LOG_WORDS.has(value) ? t(value as 'buy') : value]),
  ) as typeof line.values;
  return <>{t(`log_${line.code}` as Parameters<typeof t>[0], readable)}</>;
}
