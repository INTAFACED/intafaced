import type { QuantBacktestLogLine, QuantBacktestMetrics, QuantCheck, QuantMetric } from '@intafaced/contracts/quant-algo';
import type { ApiResult } from '../../shared/api';
import type { backtestCopy } from './backtest-copy';

// The words of one bar backtest's figures, kept apart from how they are drawn: the Backtest room's old parts
// (result-figures.tsx) and the shared result's kit-drawn room (shared-result/) both word a check, a metric and a log
// line from here, so the two say the same thing.

type BacktestT = ReturnType<typeof backtestCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

export const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export type MetricKey = keyof QuantBacktestMetrics['returns'] | keyof QuantBacktestMetrics['risk'] | keyof QuantBacktestMetrics['trades'];
const REASONS = ['no_trades', 'no_winning_trades', 'no_losing_trades', 'too_few_equity_points', 'zero_base'] as const;

const NOT_CHECKED = ['not_split', 'section_undefined', 'not_counted', 'too_few_bars', 'return_undefined', 'not_run'] as const;

/** What one check measured, in words. */
export function checkDetail(t: BacktestT, check: QuantCheck): string {
  const figure = (name: string) => check.evidence[name] ?? t('notSet');
  if (check.status === 'not_applicable') {
    const reason = check.evidence.reason ?? '';
    return (NOT_CHECKED as readonly string[]).includes(reason)
      ? t(`na_${reason as (typeof NOT_CHECKED)[number]}`)
      : t('na_other', { reason });
  }
  switch (check.name) {
    case 'sample_gap':
      return t('d_sample_gap', {
        inSample: figure('inSampleReturnPercent'),
        outOfSample: figure('outOfSampleReturnPercent'),
        gap: figure('gapPercent'),
      });
    case 'variant_count':
      return t('d_variant_count', { variants: figure('variants') });
    case 'bar_offset':
      return t('d_bar_offset', {
        base: figure('returnPercent'),
        from: check.evidence.offsetFrom ? utcText(check.evidence.offsetFrom) : t('notSet'),
        offset: figure('offsetReturnPercent'),
        shift: figure('shiftPercent'),
      });
    case 'bar_type':
      return check.evidence.kind === 'time'
        ? t('d_bar_type', { barSize: figure('barSize') })
        : t('d_bar_type_other', { barSize: figure('barSize') });
    case 'look_ahead':
      return t('d_look_ahead');
    case 'repainting':
      return t('d_repainting');
  }
}

/** A check's evidence as data attributes, each name lower-cased, so a test reads what the check measured. */
export function checkData(check: QuantCheck): Record<string, string> {
  return Object.fromEntries(Object.entries(check.evidence).map(([name, value]) => [`data-${name.toLowerCase()}`, value ?? '']));
}

/** The metrics in their three groups, each with its heading's copy key. */
export function metricGroups(metrics: QuantBacktestMetrics) {
  return [
    ['groupReturns', metrics.returns],
    ['groupRisk', metrics.risk],
    ['groupTrades', metrics.trades],
  ] as const;
}

/**
 * One figure as shown: its text, its value and, when the engine could not define it, the reason in words, never a zero.
 */
export function metricView(t: BacktestT, key: MetricKey, value: QuantMetric | number) {
  const reasonText = (reason: string) =>
    reason === 'quant.risk_free_unset'
      ? t('r_risk_free_unset')
      : (REASONS as readonly string[]).includes(reason)
        ? t(`r_${reason as (typeof REASONS)[number]}`)
        : t('r_other', { reason });
  if (typeof value === 'number') return { text: String(value), value: String(value), reason: '' };
  if (value.value === null) return { text: reasonText(value.reason ?? ''), value: '', reason: value.reason ?? '' };
  // Holding time arrives in milliseconds and reads in whole seconds.
  const text = key === 'averageHoldingMs' ? String(Math.floor(Number(value.value) / 1_000)) : value.value;
  return { text, value: value.value, reason: '' };
}

/** Values the log carries as codes (a side, a reason, a modelling choice) read in words where the copy has them. */
const LOG_WORDS = new Set([
  'buy',
  'sell',
  'signal',
  'stop_loss',
  'take_profit',
  'venue_close',
  'close_out',
  'margin_call',
  'insufficient_cash',
  'no_size',
  'unfilled_at_window_end',
  'reduce_only',
  'long_only',
  'averages_over_traded_bars',
  'stop_loss_first',
  'take_profit_without_slippage',
  'venue_close_before_exits',
  'margin_level_at_bar_low',
  'loss_beyond_margin',
  'equity_stop_at_bar_low',
  'open_position_marked_at_last_close',
  'risk_limits_not_simulated',
]);

/** One log line in words; a value the copy has a word for reads as that word. */
export function logText(t: BacktestT, line: QuantBacktestLogLine): string {
  const readable = Object.fromEntries(
    // Every word in LOG_WORDS is a copy key that takes no values.
    Object.entries(line.values).map(([key, value]) => [key, LOG_WORDS.has(value) ? t(value as 'buy') : value]),
  ) as typeof line.values;
  return t(`log_${line.code}` as Parameters<BacktestT>[0], readable);
}

/**
 * The service's typed code for a refusal: the `quant.` code the gateway passed on, or the one the message starts with
 * (svc-quant sends `<code> — <detail>`). Never a code merely quoted somewhere inside a message.
 */
export function quantCode(failure: Failed): string | null {
  if (failure.code?.startsWith('quant.')) return failure.code;
  const first = /^(quant\.[a-z_]+)\b/.exec(failure.message.trim());
  return first ? first[1]! : null;
}

/** The share refusals a signed-out reader can get, worded plainly; anything else is the shared catalogue's. */
export function publicRefusal(failure: Failed): 'publicNotFound' | 'publicBusy' | null {
  const code = quantCode(failure);
  if (code === 'quant.share_not_found') return 'publicNotFound';
  if (code === 'quant.share_rate_limited') return 'publicBusy';
  return null;
}

/** A shared result's totals, worded with the backtest room's own labels. */
export const TOTAL_KEYS = {
  startCash: 'cash',
  gross: 'gross',
  fees: 'fees',
  slippage: 'slippageTotal',
  net: 'net',
  endEquity: 'endEquity',
  openQty: 'openQty',
} as const;
