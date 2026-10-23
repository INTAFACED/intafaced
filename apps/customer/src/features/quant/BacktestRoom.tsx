import {
  QUANT_FEE_ROLES,
  QUANT_FILL_TIMINGS,
  quantBacktestFeeSchema,
  quantBacktestResultSchema,
  quantStrategyHeadSchema,
  quantStrategyListOutputSchema,
  type QuantBacktestMetrics,
  type QuantBacktestResult,
  type QuantMetric,
  type QuantStrategyHead,
} from '@intafaced/contracts/quant-algo';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Panel, Tabs } from '../../shared/ui';
import { downloadCsv } from '../more/depth-csv';
import { utcInput } from '../more/quant-analysis';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { equityGeometry, tradesCsv, tradesCsvName } from './backtest-chart';
import { backtestCopy } from './backtest-copy';
import './algo.css';
import { STRATEGY_PAGE } from './StrategyTable';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const page = quantStrategyListOutputSchema.extend({ strategies: z.array(quantStrategyHeadSchema) });

/** The inputs a refusal can name, by the word the service puts first in its message. */
const NAMED = { cash: 'cash', fees: 'feeRole', slippage: 'slippage', delay: 'delay', from: 'from', to: 'to' } as const;
type Named = (typeof NAMED)[keyof typeof NAMED] | 'fillTiming';
type Refusal = { input: Named; detail: string; blank: boolean };

/**
 * `quant.cost_unset — slippage — …`, `quant.cash_unset — cash — …`, `quant.backtest_window_invalid — from …` and
 * `quant.fill_timing_unset — …` each name one input; anything else is shown whole.
 */
function namedRefusal(message: string): Refusal | null {
  const blank = (detail: string) => /unset|fill in|choose/i.test(detail);
  const cost = /^quant\.(?:cost_unset|cash_unset) — (cash|fees|slippage|delay) (?:— )?(.*)$/.exec(message);
  if (cost) return { input: NAMED[cost[1] as keyof typeof NAMED], detail: cost[2]!.trim(), blank: blank(cost[2]!) };
  const window = /^quant\.backtest_window_(?:invalid|open) — (from|to) (.*)$/.exec(message);
  if (window) return { input: NAMED[window[1] as 'from' | 'to'], detail: window[2]!.trim(), blank: false };
  const timing = /^quant\.fill_timing_unset — (.*)$/.exec(message);
  if (timing) return { input: 'fillTiming', detail: timing[1]!.trim(), blank: blank(timing[1]!) };
  return null;
}

/**
 * The bar backtest (AL-backtest-01, AL-backtest-02): a saved signal-rules strategy, a window, starting cash and the
 * costs, run on the exchange's own closed bars. Run sends the same inputs every time, so a press after a lost reply
 * reads back the stored run rather than starting a second one. A blank cost refuses by name next to its field.
 */
export function BacktestRoom() {
  const api = useApi();
  const { t } = backtestCopy.useCopy();
  const list = useResource(
    (signal) => api.query('quant', 'studio.list', { limit: STRATEGY_PAGE }, page, { signal }),
    'quant-backtest-strategies',
  );
  const [strategyId, setStrategyId] = useState('');
  const [cash, setCash] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fillTiming, setFillTiming] = useState('');
  const [feeRole, setFeeRole] = useState('');
  const [slippage, setSlippage] = useState('');
  const [delay, setDelay] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [result, setResult] = useState<QuantBacktestResult | null>(null);

  const labels: Record<Named, string> = {
    cash: t('cash'),
    feeRole: t('feeRole'),
    slippage: t('slippage'),
    delay: t('delay'),
    from: t('from'),
    to: t('to'),
    fillTiming: t('fillTiming'),
  };
  // A refusal shows once, next to the input it names.
  const errorFor = (input: Named): ReactNode =>
    refusal?.input === input ? (
      <span role="alert" data-testid="quant-backtest-refusal">
        {refusal.blank ? t('unset', { input: labels[input] }) : t('invalid', { input: labels[input], detail: refusal.detail })}
      </span>
    ) : undefined;
  const selectError = (input: Named) => refusal?.input === input && <p className="error-text">{errorFor(input)}</p>;
  // Any change to an input makes the shown result and refusal stale, so both go.
  const edited =
    <V,>(set: (value: V) => void) =>
    (value: V) => {
      set(value);
      setResult(null);
      setRefusal(null);
      setFailure(null);
    };

  async function run(strategy: QuantStrategyHead) {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    setFailure(null);
    const res = await api.mutate(
      'quant',
      'backtest.start',
      {
        strategyId: strategy.id,
        strategyVersion: strategy.version,
        cash,
        // A field the browser cannot read as a UTC minute is sent as typed, and the service names it.
        from: utcInput(from) ?? from,
        to: utcInput(to) ?? to,
        fillTiming,
        costs: { feeRole, slippageBps: slippage, delayBars: delay },
      },
      quantBacktestResultSchema,
    );
    setBusy(false);
    if (res.ok) {
      setResult(res.data);
      return;
    }
    const named = namedRefusal(res.message);
    if (named) setRefusal(named);
    else setFailure(res);
  }

  return (
    <Panel title={t('title')}>
      <div data-testid="quant-bar-backtest">
        <p className="muted">{t('intro')}</p>
        <Read resource={list.resource} retry={list.reload}>
          {(data) => {
            if (!data.strategies.length) {
              return (
                <EmptyState title={t('strategyNone')}>
                  {t('strategyNoneBody')}{' '}
                  <a className="text-link" href="/quant/studio">
                    {t('openStudio')}
                  </a>
                </EmptyState>
              );
            }
            const strategy = data.strategies.find((row) => row.id === strategyId) ?? null;
            return (
              <form
                className="quant-bar-backtest"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (strategy) void run(strategy);
                }}
              >
                <Select
                  label={t('strategy')}
                  value={strategyId}
                  onChange={(id) => {
                    setStrategyId(id);
                    setResult(null);
                    setRefusal(null);
                    setFailure(null);
                    // The saved starting cash is the person's own figure; they may change it for this run.
                    setCash(data.strategies.find((row) => row.id === id)?.cash ?? '');
                  }}
                  options={[
                    { value: '', label: t('strategyChoose') },
                    ...data.strategies.map((row) => ({ value: row.id, label: row.name })),
                  ]}
                />
                {strategy && (
                  <p className="muted" data-testid="quant-backtest-rules">
                    {strategy.modules
                      ? t('rulesOf', { version: strategy.version, symbol: strategy.modules.symbol, barSize: strategy.modules.barSize })
                      : t('blocksOnly', { version: strategy.version })}
                  </p>
                )}
                {strategy?.modules && <FeeLedger symbol={strategy.modules.symbol} />}
                <Field
                  label={t('cash')}
                  value={cash}
                  onChange={(e) => edited(setCash)(e.target.value)}
                  inputMode="decimal"
                  maxLength={40}
                  error={errorFor('cash')}
                />
                <div className="quant-date-fields">
                  <Field
                    label={t('from')}
                    type="datetime-local"
                    value={from}
                    onChange={(e) => edited(setFrom)(e.target.value)}
                    error={errorFor('from')}
                  />
                  <Field
                    label={t('to')}
                    type="datetime-local"
                    value={to}
                    onChange={(e) => edited(setTo)(e.target.value)}
                    error={errorFor('to')}
                  />
                </div>
                <Select
                  label={t('fillTiming')}
                  value={fillTiming}
                  onChange={edited(setFillTiming)}
                  options={[{ value: '', label: t('fillChoose') }, ...QUANT_FILL_TIMINGS.map((value) => ({ value, label: t(value) }))]}
                />
                {selectError('fillTiming')}
                <Select
                  label={t('feeRole')}
                  value={feeRole}
                  onChange={edited(setFeeRole)}
                  options={[{ value: '', label: t('feeChoose') }, ...QUANT_FEE_ROLES.map((value) => ({ value, label: t(value) }))]}
                />
                {selectError('feeRole')}
                <Field
                  label={t('slippage')}
                  value={slippage}
                  onChange={(e) => edited(setSlippage)(e.target.value)}
                  inputMode="decimal"
                  maxLength={24}
                  error={errorFor('slippage')}
                />
                <Field
                  label={t('delay')}
                  value={delay}
                  onChange={(e) => edited(setDelay)(e.target.value)}
                  inputMode="numeric"
                  maxLength={3}
                  error={errorFor('delay')}
                />
                <Button type="submit" disabled={busy || !strategy} data-testid="quant-backtest-run">
                  {t('run')}
                </Button>
                {busy && <Loading label={t('running')} />}
                {failure && <Failure result={failure} retry={() => strategy && void run(strategy)} />}
              </form>
            );
          }}
        </Read>
        {result && <BacktestResult result={result} />}
      </div>
    </Panel>
  );
}

/** The published rates for the strategy's symbol, read before the run so the person sees what will be charged. */
function FeeLedger({ symbol }: { symbol: string }) {
  const api = useApi();
  const { t } = backtestCopy.useCopy();
  const fee = useResource(
    (signal) => api.query('quant', 'backtest.fee', { symbol }, quantBacktestFeeSchema, { signal }),
    `quant-fee:${symbol}`,
  );
  return (
    <div data-testid="quant-fee-ledger">
      <Read resource={fee.resource} retry={fee.reload}>
        {(data) => <p>{t('feeLedger', { version: data.version, symbol: data.symbol, taker: data.takerBps, maker: data.makerBps })}</p>}
      </Read>
    </div>
  );
}

const RESULT_TABS = ['summary', 'metrics', 'charts', 'trades'] as const;
const CHART_W = 1000;
const CHART_H = 300;
type ResultTab = (typeof RESULT_TABS)[number];

function BacktestResult({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const [tab, setTab] = useState<ResultTab>('summary');
  return (
    <section aria-label={t('resultTitle')} data-testid="quant-bar-result" data-run-id={result.runId}>
      <h3>{t('resultTitle')}</h3>
      <p className="muted">{t('simulated')}</p>
      <Tabs
        items={RESULT_TABS}
        value={tab}
        onChange={(next) => setTab(next as ResultTab)}
        label={t('resultTabs')}
        labels={{ summary: t('tabSummary'), metrics: t('tabMetrics'), charts: t('tabCharts'), trades: t('tabTrades') }}
      />
      {tab === 'summary' && <ResultSummary result={result} />}
      {tab === 'metrics' && <MetricsTab metrics={result.metrics} />}
      {tab === 'charts' && <ResultCharts result={result} />}
      {tab === 'trades' && <ResultTrades result={result} />}
    </section>
  );
}

type MetricKey = keyof QuantBacktestMetrics['returns'] | keyof QuantBacktestMetrics['risk'] | keyof QuantBacktestMetrics['trades'];
const REASONS = ['no_trades', 'no_winning_trades', 'no_losing_trades', 'too_few_equity_points', 'zero_base'] as const;

/**
 * The run's report (AL-report-01), grouped in returns, risk and trades, with a help line per figure. A figure the engine
 * could not define shows the reason in words, never a zero.
 */
function MetricsTab({ metrics }: { metrics: QuantBacktestMetrics }) {
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

function ResultSummary({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const { totals, coverage } = result;
  return (
    <>
      <h4>{t('assumptionsTitle')}</h4>
      <ul data-testid="quant-bar-assumptions">
        {result.assumptions.map((name) => (
          <li key={name} data-assumption={name}>
            {t(name)}
          </li>
        ))}
      </ul>
      <p lang="zxx" data-testid="quant-bar-run-id">
        {t('runId', { id: result.runId })}
      </p>
      <p data-testid="quant-bar-coverage">{t('coverage', { bars: coverage.bars, expected: coverage.expected })}</p>
      {coverage.gaps.length ? (
        <DataTable headers={[t('gapsTitle')]} label={t('gapsTitle')}>
          {coverage.gaps.map((gap) => (
            <tr key={gap.from} data-testid="quant-bar-gap" data-from={gap.from} data-to={gap.to}>
              <td lang="zxx">{t('gap', { from: gap.from.slice(0, 16).replace('T', ' '), to: gap.to.slice(0, 16).replace('T', ' ') })}</td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p className="muted">{t('gapsNone')}</p>
      )}
      <dl className="quant-bar-totals" data-testid="quant-bar-totals">
        {(
          [
            ['gross', totals.gross],
            ['fees', totals.fees],
            ['slippageTotal', totals.slippage],
            ['net', totals.net],
            ['endEquity', totals.endEquity],
            ['openQty', totals.openQty],
          ] as const
        ).map(([key, value]) => (
          <div key={key} data-testid={`quant-bar-total-${key}`} data-value={value}>
            <dt>{t(key)}</dt>
            <dd lang="zxx">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The run's fills with their side, and the orders that did not fill (AL-report-02), with a CSV of the fills. */
function ResultTrades({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const [saved, setSaved] = useState<boolean | null>(null);
  return (
    <div data-testid="quant-bar-trades">
      <Button
        type="button"
        data-testid="quant-bar-csv"
        disabled={!result.trades.length}
        onClick={() => setSaved(downloadCsv(tradesCsvName(result.runId), tradesCsv(result)))}
      >
        {t('downloadCsv')}
      </Button>
      {saved === false && <p className="error-text">{t('csvFailed')}</p>}
      {result.trades.length ? (
        <DataTable
          headers={[t('time'), t('side'), t('reason'), t('qty'), t('barPrice'), t('price'), t('fee'), t('slippageTotal')]}
          label={t('tradesTitle')}
        >
          {result.trades.map((trade, i) => (
            <tr key={`${trade.ts}:${i}`} data-testid="quant-bar-trade" data-ts={trade.ts} data-side={trade.side}>
              <td lang="zxx">{trade.ts.slice(0, 16).replace('T', ' ')}</td>
              <td>{t(trade.side)}</td>
              <td>{t(trade.reason)}</td>
              <td lang="zxx">{trade.qty}</td>
              <td lang="zxx">{trade.barPrice}</td>
              <td lang="zxx">{trade.price}</td>
              <td lang="zxx">{trade.fee}</td>
              <td lang="zxx">{trade.slippage}</td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <p className="muted">{t('tradesNone')}</p>
      )}
      {result.rejected.length > 0 && (
        <DataTable headers={[t('time'), t('side'), t('reason')]} label={t('rejectedTitle')}>
          {result.rejected.map((row, i) => (
            <tr key={`${row.ts}:${i}`} data-testid="quant-bar-rejected" data-reason={row.reason}>
              <td lang="zxx">{row.ts.slice(0, 16).replace('T', ' ')}</td>
              <td>{t(row.side)}</td>
              <td>{t(row.reason)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}

/** The equity curve with a marker on each fill (green buy, red sell); the table under it carries the same numbers. */
function ResultCharts({ result }: { result: QuantBacktestResult }) {
  const { t } = backtestCopy.useCopy();
  const geometry = equityGeometry(result, CHART_W, CHART_H);
  return (
    <div data-testid="quant-bar-charts">
      {geometry ? (
        <figure className="quant-equity-chart">
          <svg
            viewBox={`-8 -8 ${CHART_W + 16} ${CHART_H + 16}`}
            role="img"
            aria-label={t('chartLabel')}
            data-testid="quant-bar-equity-chart"
          >
            <polyline
              points={geometry.line}
              fill="none"
              style={{ stroke: 'var(--if-lime)' }}
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {geometry.markers.map((marker, i) => {
              // Shape carries the side, not colour alone: a triangle up for a buy, down for a sell.
              const x = Number(marker.x);
              const y = Number(marker.y);
              const points =
                marker.side === 'buy'
                  ? `${x - 9},${y + 8} ${x + 9},${y + 8} ${x},${y - 8}`
                  : `${x - 9},${y - 8} ${x + 9},${y - 8} ${x},${y + 8}`;
              return (
                <polygon
                  key={`${marker.ts}:${i}`}
                  points={points}
                  style={{ fill: marker.side === 'buy' ? 'var(--if-up-text)' : 'var(--if-down-text)' }}
                  data-testid="quant-bar-marker"
                  data-side={marker.side}
                  data-ts={marker.ts}
                >
                  <title>{t('markerTitle', { side: t(marker.side), time: marker.ts.slice(0, 16).replace('T', ' ') })}</title>
                </polygon>
              );
            })}
          </svg>
          <figcaption className="muted">{t('chartCaption')}</figcaption>
          {geometry.unmatched > 0 && <p className="error-text">{t('chartUnmatched', { count: geometry.unmatched })}</p>}
        </figure>
      ) : (
        <p className="muted">{t('chartTooFew')}</p>
      )}
      <details>
        <summary>{t('equityTitle')}</summary>
        <DataTable headers={[t('time'), t('equity')]} label={t('equityTitle')}>
          {result.equity.map((point) => (
            <tr key={point.ts} data-testid="quant-bar-equity" data-equity={point.equity}>
              <td lang="zxx">{point.ts.slice(0, 16).replace('T', ' ')}</td>
              <td lang="zxx">{point.equity}</td>
            </tr>
          ))}
        </DataTable>
      </details>
    </div>
  );
}
